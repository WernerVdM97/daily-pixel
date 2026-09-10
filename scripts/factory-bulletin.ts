// Dark Factory bulletin — the one place that answers "what is waiting on the human?".
//
// The loops report what *changed* (scrumo's DM digest) and what is *wrong* (the sweeper's
// audit), but the board cannot be read as a to-do list, and that is a real defect rather
// than a missing view. A `Blocked` item looks identical whether triage wrote a question
// naming the decision it needs or forgot to write one at all — and six items were sitting
// Blocked with `needs-human-decision` and zero comments. A filter that cannot tell those
// apart trains the owner to ignore the column, which is worse than no filter.
//
// So the bulletin splits the human-gated work by *what the owner can actually do*:
// answer (a question exists), re-read (the owner already answered and triage has not
// looked), fix the factory (nobody ever asked), approve, merge. It is regenerated in
// place on one pinned issue, so the pin cannot go stale, and it needs no Discord token,
// so it works headless on a host where the DM path is broken.
//
// Usage:
//   tsx scripts/factory-bulletin.ts                    # print the bulletin, no writes
//   tsx scripts/factory-bulletin.ts --post             # create/update the pinned issue
//   tsx scripts/factory-bulletin.ts --json             # structured queue instead of markdown
//   tsx scripts/factory-bulletin.ts --agent-login x    # extra login counted as an agent
//
// Reads the board ids from `.pi/factory/project.json`, matches issues by number, and
// treats every comment author outside `--agent-login` as human (so a login change or a
// second maintainer does not silently reclassify the owner as the factory).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BULLETIN_TITLE = "Dark Factory bulletin";
const BULLETIN_MARKER = "<!-- factory-bulletin -->";

/** Logins that write as the factory. Anything else in a comment author is the human. */
const DEFAULT_AGENT_LOGINS = ["agent97eth"];

/** Statuses in board order, so the "at a glance" table reads like the flow. */
const STATUS_ORDER = [
  "Inbox",
  "Triaged",
  "Approved",
  "In Progress",
  "In Review",
  "Blocked",
  "Done",
] as const;

const PRIORITY_RANK: Record<string, number> = {
  "P0 - urgent": 0,
  "P1 - high": 1,
  "P2 - normal": 2,
  "P3 - low": 3,
};

/** Statuses whose meaning depends on who spoke last, so their comments are fetched. */
const COMMENT_STATUSES = new Set(["Blocked", "Triaged", "In Review"]);

const MAX_ROWS = 15;
const EXCERPT_CHARS = 110;

// ── Options ────────────────────────────────────────────────────────────────

interface Options {
  post: boolean;
  json: boolean;
  agentLogins: Set<string>;
}

function printUsage(): void {
  process.stdout.write(`Dark Factory bulletin.

Usage:
  tsx scripts/factory-bulletin.ts [--post] [--json] [--agent-login <login>]

Flags:
  --post                 create or update the pinned bulletin issue (default: print only)
  --json                 emit the structured queue as JSON
  --agent-login <login>  count this login as the factory, not the human (repeatable)
  --help, -h             this text
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    post: false,
    json: false,
    agentLogins: new Set(DEFAULT_AGENT_LOGINS),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--post") opts.post = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--agent-login") opts.agentLogins.add(argv[++i]);
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return opts;
}

// ── Board shapes ───────────────────────────────────────────────────────────

interface ProjectConfig {
  projectNumber: number;
  owner: string;
  repo: string;
}

export interface BoardItem {
  number: number;
  title: string;
  url: string;
  status: string;
  priority: string | null;
  milestone: string | null;
  labels: string[];
}

export interface Comment {
  author: string;
  createdAt: string;
  body: string;
}

export interface Entry {
  number: number;
  title: string;
  url: string;
  milestone: string | null;
  priority: string | null;
  /** Age of the thing that is now waiting, in ms. Null when the item carries no clock. */
  sinceMs: number | null;
  excerpt: string;
}

export interface Queue {
  /** Blocked, question written, no human reply since. The owner's answer queue. */
  answer: Entry[];
  /** Blocked, the human spoke last: triage has not processed the answer yet. */
  answered: Entry[];
  /** Blocked with `needs-human-decision` and no comments at all: nothing to answer. */
  neverAsked: Entry[];
  /** Triaged: approval is the owner's move, and it is the only thing that releases work. */
  approve: Entry[];
  /** In Review, or an open PR to the integration branch. */
  merge: Entry[];
  statusCounts: Record<string, number>;
  notes: string[];
}

// ── Fetching ───────────────────────────────────────────────────────────────

function gh(args: string[], input?: string): string {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
      cwd: REPO_ROOT,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${detail}`);
  }
}

function ghJson<T>(args: string[]): T {
  const raw = gh(args);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`gh ${args.slice(0, 3).join(" ")} returned unparseable JSON: ${detail}`);
  }
}

function readProjectConfig(): ProjectConfig {
  const path = resolve(REPO_ROOT, ".pi/factory/project.json");
  let raw: { projectNumber: number; owner: string; repo: string };
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as {
      projectNumber: number;
      owner: string;
      repo: string;
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read ${path}: ${detail}`);
  }
  return { projectNumber: raw.projectNumber, owner: raw.owner, repo: raw.repo };
}

interface RawItem {
  content?: { number?: number; title?: string; url?: string; type?: string };
  status?: string;
  priority?: string | null;
  labels?: string[];
  milestone?: { title?: string };
}

/** Board items, normalised. Draft issues have no number and are skipped. */
function fetchBoard(config: ProjectConfig): BoardItem[] {
  const raw = ghJson<{ items: RawItem[] }>([
    "project",
    "item-list",
    String(config.projectNumber),
    "--owner",
    config.owner,
    "--format",
    "json",
    "--limit",
    "500",
  ]);
  const items: BoardItem[] = [];
  for (const entry of raw.items ?? []) {
    const number = entry.content?.number;
    if (number === undefined) continue;
    items.push({
      number,
      title: entry.content?.title ?? entry.content?.url ?? `#${number}`,
      url: entry.content?.url ?? `https://github.com/${config.repo}/issues/${number}`,
      status: entry.status ?? "Inbox",
      priority: entry.priority ?? null,
      milestone: entry.milestone?.title ?? null,
      labels: entry.labels ?? [],
    });
  }
  return items;
}

/** Comments per issue, oldest first. Only fetched for the numbers the caller needs. */
function fetchComments(repo: string, numbers: number[]): Map<number, Comment[]> {
  const byNumber = new Map<number, Comment[]>();
  for (const number of numbers) {
    const raw = ghJson<{
      comments: { author?: { login?: string }; createdAt?: string; body?: string }[];
    }>(["issue", "view", String(number), "--repo", repo, "--json", "comments"]);
    byNumber.set(
      number,
      (raw.comments ?? []).map((c) => ({
        author: c.author?.login ?? "unknown",
        createdAt: c.createdAt ?? "",
        body: c.body ?? "",
      })),
    );
  }
  return byNumber;
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  baseRefName: string;
}

function fetchOpenPrsOn(repo: string, base: string): RawPr[] {
  const prs = ghJson<RawPr[]>([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,url,isDraft,baseRefName",
  ]);
  return prs.filter((pr) => pr.baseRefName === base && !pr.isDraft);
}

// ── Classification ─────────────────────────────────────────────────────────

function priorityRank(priority: string | null): number {
  return priority ? (PRIORITY_RANK[priority] ?? 9) : 8;
}

function byPriorityThenAge(a: Entry, b: Entry): number {
  const rank = priorityRank(a.priority) - priorityRank(b.priority);
  if (rank !== 0) return rank;
  const age = (b.sinceMs ?? 0) - (a.sinceMs ?? 0);
  if (age !== 0) return age;
  return a.number - b.number;
}

/**
 * Triage's comment headers are not all shaped `**Triage: ...**`: a pass may open with
 * `**Triage 2026-09-10.** <the actual question>` on one line. Match the header itself, with
 * or without a colon, so the substance after it survives instead of being skipped as header.
 */
const TRIAGE_HEADER = /^\*\*Triage\b[^*]*\*\*[:\s]*/i;

/**
 * Triage marks the exact ask on its own `**Question:**` line, after any preamble. That line is
 * what the owner has to answer, so it beats the first sentence of the comment as an excerpt.
 */
const QUESTION_HEADER = /^(?:\*\*)?Question:?(?:\*\*)?:?\s*/i;

/** One line of a comment, with the triage boilerplate and markdown stripped. */
export function toExcerpt(body: string, max = EXCERPT_CHARS): string {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Header-stripped candidates, so a line that is nothing but header can be passed over. A
  // comment that is *only* header falls back to showing it, because a blank question cell
  // reads as a rendering bug rather than as "this comment says nothing".
  const candidates = lines.map((line) => line.replace(TRIAGE_HEADER, "").trim());
  // A bare `**Question:**` with the text on the next line carries no ask of its own, so it is
  // passed over by both searches rather than reported as an empty question.
  const withoutMarker = (line: string) => line.replace(QUESTION_HEADER, "").trim();
  const asked = candidates.find(
    (line) => QUESTION_HEADER.test(line) && withoutMarker(line).length > 0,
  );
  const meaningful =
    asked ?? candidates.find((line) => withoutMarker(line).length > 0) ?? lines[0] ?? "";
  const cleaned = meaningful
    .replace(QUESTION_HEADER, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function ageMs(createdAt: string, nowMs: number): number | null {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : Math.max(0, nowMs - parsed);
}

type Bucket = "answer" | "answered" | "neverAsked" | "approve" | "merge";

function lastComment(comments: Comment[]): Comment | null {
  return comments.at(-1) ?? null;
}

function toEntry(item: BoardItem, sinceMs: number | null, excerpt: string): Entry {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    milestone: item.milestone,
    priority: item.priority,
    sinceMs,
    excerpt,
  };
}

interface ClassifyOpts {
  agentLogins: ReadonlySet<string>;
  nowMs: number;
}

/**
 * `needs-human-decision` with no comments means nobody wrote the question, which is a
 * factory defect rather than a decision the owner can make. It gets its own bucket so it
 * cannot pad the answer queue and train the owner to skim past real questions.
 */
function classifyBlocked(
  item: BoardItem,
  comments: Comment[],
  opts: ClassifyOpts,
): { bucket: Bucket; entry: Entry } {
  const last = lastComment(comments);
  if (!last) return { bucket: "neverAsked", entry: toEntry(item, null, "") };
  const since = ageMs(last.createdAt, opts.nowMs);
  return opts.agentLogins.has(last.author)
    ? { bucket: "answer", entry: toEntry(item, since, toExcerpt(last.body)) }
    : { bucket: "answered", entry: toEntry(item, since, toExcerpt(last.body, 90)) };
}

function classifyItem(
  item: BoardItem,
  comments: Comment[],
  opts: ClassifyOpts,
): { bucket: Bucket; entry: Entry } | null {
  if (item.status === "Blocked") return classifyBlocked(item, comments, opts);
  const last = lastComment(comments);
  const since = last ? ageMs(last.createdAt, opts.nowMs) : null;
  if (item.status === "Triaged") {
    return { bucket: "approve", entry: toEntry(item, since, last ? toExcerpt(last.body, 90) : "") };
  }
  if (item.status === "In Review") return { bucket: "merge", entry: toEntry(item, since, "") };
  return null;
}

/** The three facts that change what the owner does next, and nothing else. */
function buildNotes(queue: Queue): string[] {
  const notes: string[] = [];
  if (queue.answer.length > 0) {
    notes.push(
      `**${queue.answer.length}** item(s) are waiting on an answer. Reply as a comment on the issue: a comment is what triage reads, and a reply in Discord never reaches it.`,
    );
  }
  if ((queue.statusCounts.Approved ?? 0) === 0) {
    notes.push(
      "Nothing is `Approved`, so the executor has nothing to pick up. Every card in `Triaged` is idle until you move it.",
    );
  }
  if (queue.neverAsked.length > 0) {
    notes.push(
      `**${queue.neverAsked.length}** item(s) are \`Blocked\` with \`needs-human-decision\` and no comments at all, so nobody has written the question: that is a factory defect for triage to fix, not a decision for you.`,
    );
  }
  return notes;
}

/**
 * Split the board into the five human-gated buckets. Pure: takes the item list and the
 * comments it needs, so the rules can be tested without a gh call.
 */
export function classifyBoard(
  items: BoardItem[],
  commentsByNumber: Map<number, Comment[]>,
  opts: ClassifyOpts,
): Queue {
  const queue: Queue = {
    answer: [],
    answered: [],
    neverAsked: [],
    approve: [],
    merge: [],
    statusCounts: {},
    notes: [],
  };

  for (const item of items) {
    queue.statusCounts[item.status] = (queue.statusCounts[item.status] ?? 0) + 1;
    const classified = classifyItem(item, commentsByNumber.get(item.number) ?? [], opts);
    if (classified) queue[classified.bucket].push(classified.entry);
  }

  queue.answer.sort(byPriorityThenAge);
  queue.answered.sort(byPriorityThenAge);
  queue.approve.sort(byPriorityThenAge);
  queue.merge.sort(byPriorityThenAge);
  queue.neverAsked.sort((a, b) => a.number - b.number);
  queue.notes = buildNotes(queue);

  return queue;
}

// ── Rendering ──────────────────────────────────────────────────────────────

export function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function table(rows: Entry[], columns: (e: Entry) => string[]): string[] {
  const shown = rows.slice(0, MAX_ROWS);
  const out = shown.map((e) => `| ${columns(e).join(" | ")} |`);
  if (rows.length > shown.length) {
    out.push(`| … | **${rows.length - shown.length} more** | | | | |`);
  }
  return out;
}

function truncate(markdown: string): string {
  return markdown.replace(/\n+$/, "");
}

export function renderBulletin(queue: Queue, generatedAt: Date): string {
  const stamp = generatedAt.toISOString().replace(/\.\d+Z$/, "Z");
  const lines: string[] = [];

  lines.push(BULLETIN_MARKER);
  lines.push("");
  lines.push(`_Generated ${stamp} by \`scripts/factory-bulletin.ts\`. Regenerated in place by the sweeper; editing this body by hand is pointless._`);
  lines.push("");
  lines.push(`# ${BULLETIN_TITLE}`);
  lines.push("");
  lines.push(
    `**Waiting on you: ${queue.answer.length}** · answered, waiting on triage: ${queue.answered.length} · no question written: ${queue.neverAsked.length} · ready to approve: ${queue.approve.length} · ready to merge: ${queue.merge.length}`,
  );
  lines.push("");

  if (queue.answer.length > 0) {
    lines.push("## Waiting on you");
    lines.push("");
    lines.push("| # | Item | Milestone | Priority | Question | Asked |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    lines.push(
      ...table(queue.answer, (e) => [
        `[#${e.number}](${e.url})`,
        e.title,
        e.milestone ?? "—",
        e.priority ?? "—",
        e.excerpt,
        formatAge(e.sinceMs),
      ]),
    );
    lines.push("");
  }

  if (queue.answered.length > 0) {
    lines.push("## Answered, waiting on triage");
    lines.push("");
    lines.push("You have replied; triage has not re-read these yet. Nothing more is needed from you.");
    lines.push("");
    lines.push("| # | Item | Your reply | Replied |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(
      ...table(queue.answered, (e) => [
        `[#${e.number}](${e.url})`,
        e.title,
        e.excerpt,
        formatAge(e.sinceMs),
      ]),
    );
    lines.push("");
  }

  if (queue.neverAsked.length > 0) {
    lines.push("## Blocked with no question written");
    lines.push("");
    lines.push(
      `${queue.neverAsked.map((e) => `[#${e.number}](${e.url})`).join(", ")} — \`needs-human-decision\` with no comments, so there is nothing to answer. Triage must state the exact question.`,
    );
    lines.push("");
  }

  if (queue.approve.length > 0) {
    lines.push("## Ready to approve");
    lines.push("");
    lines.push("Move the card to `Approved` on the board. A comment is not an approval.");
    lines.push("");
    lines.push("| # | Item | Milestone | Priority |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(
      ...table(queue.approve, (e) => [
        `[#${e.number}](${e.url})`,
        e.title,
        e.milestone ?? "—",
        e.priority ?? "—",
      ]),
    );
    lines.push("");
  }

  if (queue.merge.length > 0) {
    lines.push("## Ready to merge");
    lines.push("");
    lines.push("| # | Item | Waiting |");
    lines.push("| --- | --- | --- |");
    lines.push(
      ...table(queue.merge, (e) => [
        `[#${e.number}](${e.url})`,
        e.title,
        formatAge(e.sinceMs),
      ]),
    );
    lines.push("");
  }

  lines.push("## Board at a glance");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("| --- | --- |");
  for (const status of STATUS_ORDER) {
    const count = queue.statusCounts[status] ?? 0;
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push("");

  if (queue.notes.length > 0) {
    lines.push("## How to read this");
    lines.push("");
    for (const note of queue.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return `${truncate(lines.join("\n"))}\n`;
}

// ── Posting ────────────────────────────────────────────────────────────────

interface BulletinIssue {
  number: number;
  url: string;
  isPinned: boolean;
}

/** The existing bulletin issue, or null. Matched on the exact title, so it is findable. */
function findBulletin(repo: string): BulletinIssue | null {
  const issues = ghJson<{ number: number; title: string; url: string; isPinned: boolean }[]>([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--search",
    `"${BULLETIN_TITLE}" in:title`,
    "--json",
    "number,title,url,isPinned",
  ]);
  return issues.find((i) => i.title === BULLETIN_TITLE) ?? null;
}

/** Create or update the bulletin in place, and make sure it is pinned. Returns its url. */
function publishBulletin(repo: string, body: string): string {
  const existing = findBulletin(repo);
  if (!existing) {
    const url = gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      BULLETIN_TITLE,
      "--body-file",
      "-",
    ], body).trim();
    const number = Number.parseInt(url.split("/").pop() ?? "", 10);
    if (Number.isFinite(number)) gh(["issue", "pin", String(number), "--repo", repo]);
    return url;
  }
  gh(["issue", "edit", String(existing.number), "--repo", repo, "--body-file", "-"], body);
  if (!existing.isPinned) gh(["issue", "pin", String(existing.number), "--repo", repo]);
  return existing.url;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const config = readProjectConfig();
  const nowMs = Date.now();

  const items = fetchBoard(config);
  const needsComments: number[] = [];
  for (const item of items) {
    if (COMMENT_STATUSES.has(item.status)) needsComments.push(item.number);
  }
  const commentsByNumber = fetchComments(config.repo, needsComments);

  const queue = classifyBoard(items, commentsByNumber, {
    agentLogins: opts.agentLogins,
    nowMs,
  });

  // Open non-draft PRs to the integration branch are the factory's other merge queue:
  // an executor that opened a PR but never moved the card would otherwise be invisible.
  for (const pr of fetchOpenPrsOn(config.repo, "dev")) {
    if (queue.merge.some((e) => e.number === pr.number)) continue;
    queue.merge.push({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      milestone: null,
      priority: null,
      sinceMs: null,
      excerpt: "",
    });
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ generatedAt: new Date(nowMs).toISOString(), ...queue }, null, 2)}\n`,
    );
  } else {
    const body = renderBulletin(queue, new Date(nowMs));
    if (opts.post) {
      process.stdout.write(`${publishBulletin(config.repo, body)}\n`);
    } else {
      process.stdout.write(body);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
