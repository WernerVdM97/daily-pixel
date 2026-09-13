// Dark Factory friction metrics — the mechanical half of meta-oil's "where does the
// factory get confused" question.
//
// The factory's runs are gone once they end: a scheduled loop runs with `context: "fresh"`
// and only `.pi/factory/memory/` survives. The evidence of *how* a run struggled lives in
// the session transcripts under `~/.pi/agent/sessions/`, which record every tool call, its
// error flag, and the tokens each turn cost. This script turns those transcripts into
// ranked signals so the interpreting agent spends its tokens on diagnosis, not counting.
//
// Every number here is a PROXY. None of it is a probability, a logprob, or a measurement
// of "confusion" — it is incidence of behaviours that correlate with wasted work. The
// agent is expected to read the offending sessions before trusting a ranking.
//
// Four attribution layers, because a ranking you cannot act on is noise:
//   - every session is labelled with the factory loop that ran it (subagent session names,
//     scheduler launchers, else interactive), so signals name a loop, not a bare id;
//   - failed bash calls that read as deliberate nonzero-exit probes (grep/diff/test used as
//     boolean checks) are tallied separately and excluded from the tool-error ranking;
//   - the job ledger under `.pi/factory/jobs/` is summarised into executor outcome metrics
//     (first-try stage pass rate, retries, budget burn) — transcripts say how a run felt,
//     the ledger says whether it delivered;
//   - `--board` adds the triage outcome proxy: Blocked board items whose latest comment is
//     the owner's, i.e. an answer sitting unprocessed while triage passes over it.
//
// Usage:
//   tsx scripts/factory-friction.ts                     # last 7 days, text brief
//   tsx scripts/factory-friction.ts --since 3d --top 8
//   tsx scripts/factory-friction.ts --errors 20         # the failed calls behind the ranking
//   tsx scripts/factory-friction.ts --board              # + board staleness (needs gh)
//   tsx scripts/factory-friction.ts --json              # full structured report
//   tsx scripts/factory-friction.ts --sessions ~/.pi/agent/sessions --all-projects

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
// The ledger's own budget, imported rather than mirrored: a copy drifts the first time a
// stage budget moves, and the drainer clamps every stage to what remains of this one.
import { JOB_CAP_MS } from "./factory-jobs.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Options ────────────────────────────────────────────────────────────────

interface Options {
  sessionsRoot: string;
  projectDir: string | null;
  allProjects: boolean;
  cacheShards: string;
  jobsDir: string;
  board: boolean;
  sinceMs: number;
  top: number;
  json: boolean;
  errors: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    sessionsRoot: join(homedir(), ".pi", "agent", "sessions"),
    projectDir: null,
    allProjects: false,
    cacheShards: join(homedir(), ".pi", "agent", "pi-cache-optimizer-stats.d", "shards"),
    jobsDir: join(REPO_ROOT, ".pi", "factory", "jobs"),
    board: false,
    sinceMs: 7 * 24 * 60 * 60 * 1000,
    top: 5,
    json: false,
    errors: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sessions") opts.sessionsRoot = resolve(argv[++i]);
    else if (a === "--project") opts.projectDir = argv[++i];
    else if (a === "--all-projects") opts.allProjects = true;
    else if (a === "--cache-shards") opts.cacheShards = resolve(argv[++i]);
    else if (a === "--jobs-dir") opts.jobsDir = resolve(argv[++i]);
    else if (a === "--board") opts.board = true;
    else if (a === "--since") opts.sinceMs = parseSpan(argv[++i]);
    else if (a === "--top") opts.top = Number.parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--errors") {
      const next = argv[i + 1];
      opts.errors = next && /^\d+$/.test(next) ? Number.parseInt(argv[++i], 10) : 20;
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(1);
    }
  }
  if (!Number.isFinite(opts.sinceMs) || opts.sinceMs <= 0) {
    console.error("--since must be a span like 7d, 24h, 90m, or 3600s");
    process.exit(1);
  }
  if (!Number.isFinite(opts.top) || opts.top < 1) opts.top = 5;
  return opts;
}

function printUsage(): void {
  console.error(
    [
      "Usage: tsx scripts/factory-friction.ts [options]",
      "",
      "  --sessions <dir>   session log root (default: ~/.pi/agent/sessions)",
      "  --project <name>   one project folder inside the root (default: derived from the repo path)",
      "  --all-projects     aggregate every project folder instead of this repo's",
      "  --since <span>     window, e.g. 7d / 24h / 90m (default: 7d)",
      "  --cache-shards <dir>  pi-cache-optimizer shard dir (default: the agent dir's)",
      "  --jobs-dir <dir>   factory job ledger dir (default: <repo>/.pi/factory/jobs)",
      "  --board            add board staleness: Blocked items with an unprocessed owner answer (needs gh)",
      "  --top <n>          instances listed per signal (default: 5)",
      "  --errors [n]       list failed tool calls (tool, session, first line; default 20)",
      "  --json             machine-readable report instead of the text brief",
    ].join("\n"),
  );
}

/** Spans are relative (`7d`), not dates: the windows meta-oil compares are recency windows. */
function parseSpan(raw: string | undefined): number {
  if (!raw) return Number.NaN;
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(raw.trim());
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]];
  return n * (unit ?? Number.NaN);
}

// ── Locating transcripts ───────────────────────────────────────────────────

/**
 * Pi escapes a project cwd into a session folder name by replacing `/` with `-` and
 * wrapping the result in an extra leading `-` and trailing `--`. So
 * `/home/werner/projects/daily-pixel` becomes `--home-werner-projects-daily-pixel--`.
 * The exact form is checked first, then the escaped form, then any folder whose name
 * ends with the repo basename, so a rename upstream degrades to a match instead of a
 * silently empty report.
 */
function projectFolderCandidates(root: string): string[] {
  const escaped = REPO_ROOT.replace(/\//g, "-");
  const exact = `-${escaped}--`;
  const loose = `${escaped}--`;
  if (existsSync(join(root, exact))) return [exact];
  if (existsSync(join(root, loose))) return [loose];
  const tail = `-${basename(REPO_ROOT)}--`;
  const matches = readdirSync(root).filter((d) => d.endsWith(tail));
  return matches.length ? matches : [exact];
}

function collectTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, depth + 1);
      else if (entry.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

// ── Fork replay ────────────────────────────────────────────────────────────

/**
 * A fork replays its parent's entries verbatim under the same ids, so counting them
 * again double-counts every failure, token and command the parent already contributed:
 * one session with 10 forks reads as eleven sessions with the same six failures. Only
 * the entries a fork itself created are new, so the ancestor's ids are the skip set.
 * The chain is followed through `parentSession` (an absolute path in the fork header),
 * and a missing or cyclic ancestor degrades to no skipping rather than to a wrong count.
 */
function parentSessionOf(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
  try {
    const header = JSON.parse(firstLine);
    return header?.type === "session" && typeof header.parentSession === "string" ? header.parentSession : null;
  } catch {
    return null;
  }
}

/** Every entry id a transcript holds: exactly what a fork of it would replay. */
function entryIdsOf(file: string, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(file);
  if (cached) return cached;
  const ids = new Set<string>();
  cache.set(file, ids); // stored before reading so a fork cycle cannot recurse for ever
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return ids;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id === "string") ids.add(entry.id);
    } catch {
      continue;
    }
  }
  return ids;
}

function ancestorEntryIds(file: string, cache: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>([file]);
  let current = parentSessionOf(file);
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const id of entryIdsOf(current, cache)) out.add(id);
    current = parentSessionOf(current);
  }
  return out;
}

// ── Reading one transcript ─────────────────────────────────────────────────

interface FailedCall {
  tool: string;
  session: string;
  at: number;
  firstLine: string;
  /** True when the nonzero exit was the point of the command: a probe, not friction. */
  probe: boolean;
}

interface SessionStats {
  file: string;
  id: string;
  fork: boolean;
  /** Factory loop that ran this session: a subagent agent name, `scheduler-run`, or `interactive`. */
  agent: string;
  startedAt: number;
  endedAt: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  toolResults: number;
  failedTools: Record<string, number>;
  /** Failed calls that read as deliberate probes, by tool: excluded from the tool-error ranking. */
  probeTools: Record<string, number>;
  failedCalls: FailedCall[];
  aborts: number;
  providerErrors: number;
  reasoningTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  models: Record<string, number>;
  commands: string[];
  editedFiles: string[];
  correctionTurns: number;
  shipped: boolean;
  signals: Record<string, number>;
  /** Per label, how many times this session itself hit it: an offender is session-scoped. */
  offenders: Record<string, Record<string, number>>;
}

const CORRECTION = /^\s*(no\b|nope|not\b|actually|wait\b|stop\b|wrong|that'?s (not|wrong)|still (broken|failing)|didn'?t work|revert|undo|again\b)/i;
const SHIPPED = /git commit|gh pr create|gh pr merge/i;

/** A scheduled loop's launcher brief: the headless session that fires `schedule.run-due`. */
const SCHEDULE_LAUNCHER = /schedule\.run-due/;

/** `subagent-<agent>-<runUuid>-<n>`: the run id is a strict hex group, so a hyphenated agent name parses. */
const SUBAGENT_NAME = /^subagent-([a-z0-9][a-z0-9-]*?)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i;

/**
 * Which loop ran a session. Priority: the run's own subagent name (the agent frontmatter
 * pi stamps into `session_info`), then the scheduler launcher brief, else an interactive
 * owner session. A fork replays its parent's entries, so it inherits the parent's label.
 */
export function agentOf(subagentName: string | null, firstUserText: string): string {
  if (subagentName) {
    const m = SUBAGENT_NAME.exec(subagentName);
    if (m) return m[1];
  }
  if (SCHEDULE_LAUNCHER.test(firstUserText)) return "scheduler-run";
  return "interactive";
}

/**
 * A probe is a failed bash call whose nonzero exit was the point of the command: the model
 * used it as a boolean (grep for absence, diff-as-check, a negation, an existence test) and
 * read the exit code, not the error. Such calls are not friction — counting them inflates
 * tool-error with deliberate behaviour (24% of it in the 2026-09-12 survey) and buries the
 * signals worth diagnosing. The command comes from the toolCall entry (a bash result does
 * not reliably echo it: stderr often lands first), so `readSession` pairs the two by call id.
 * `ls` only counts as a probe when the error is a missing path, since a wrong path
 * assumption is just as often a genuine failure.
 */
export function isProbeExit(tool: string, command: string, resultText: string): boolean {
  if (tool !== "bash") return false;
  // A chain exits with its last command's status, pipes included (pi sets no `pipefail`), so
  // only the final segment can explain the failure: `cd x && grep -q y f` is a probe, while
  // `grep y f | head; echo ---; ls .claude/skills` that dies on the `ls` is a probe for the
  // `ls` and not for the grep in front of it.
  const last = command.trim().split(/;|&&|\|\||\|/).at(-1)?.trim() ?? "";
  if (!last) return false;
  // A command the shell could not parse is a model error, never a deliberate check.
  if (/unexpected EOF|syntax error near|unterminated/i.test(resultText)) return false;
  if (/^!\s/.test(last)) return true;
  if (/^(grep|diff|cmp)\b/.test(last)) return true; // no-match and files-differ exits are the check itself
  if (/^(test\s+(-[efd]|--)|\[\s+(-[efd]|--))/.test(last)) return true;
  if (/^git\s+(rev-parse\s+--verify|cat-file\s+-e)\b/.test(last)) return true;
  if (/^ls\b/.test(last) && /No such file or directory/.test(resultText)) return true;
  return false;
}

function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 110 ? `${one.slice(0, 107)}...` : one;
}

/** The first line of a failed call's text, collapsed and capped: enough to name the cause. */
function firstLineOf(parts: any[]): string {
  const text = parts.find((p) => p?.type === "text" && typeof p.text === "string")?.text ?? "";
  const line = String(text).split("\n")[0].replace(/\s+/g, " ").trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function readSession(file: string, ancestorIds: Set<string>): SessionStats {
  const stats: SessionStats = {
    file,
    id: basename(file).replace(/\.jsonl$/, ""),
    fork: file.includes("/forks/"),
    agent: "interactive",
    startedAt: 0,
    endedAt: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolResults: 0,
    failedTools: {},
    probeTools: {},
    failedCalls: [],
    aborts: 0,
    providerErrors: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    models: {},
    commands: [],
    editedFiles: [],
    correctionTurns: 0,
    shipped: false,
    signals: {},
    offenders: {},
  };

  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return stats;
  }

  const fileStat = statSync(file);
  let firstUserSeen = false;
  let firstUserText = "";
  let subagentName: string | null = null;
  // toolCall id → the command it ran, so a failed bash result can be judged on its command
  // even when stderr lands before any echo of it in the result text.
  const callCommands = new Map<string, string>();
  let headerId = "";

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A truncated final line in a live session is expected, not an error.
    }

    // Skipped before every counter below, so a replayed entry contributes nothing at all.
    if (typeof entry?.id === "string" && ancestorIds.has(entry.id)) continue;

    const ts = Date.parse(entry?.timestamp ?? "");
    if (Number.isFinite(ts)) {
      if (!stats.startedAt || ts < stats.startedAt) stats.startedAt = ts;
      if (ts > stats.endedAt) stats.endedAt = ts;
    }
    if (entry?.type === "session" && typeof entry.id === "string") headerId = entry.id;
    if (entry?.type === "session_info" && typeof entry.name === "string") subagentName = entry.name;
    if (entry?.type !== "message") continue;
    const msg = entry.message ?? {};
    const parts: any[] = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === "user") {
      stats.userTurns++;
      const said = parts
        .filter((p) => p?.type === "text")
        .map((p) => String(p.text ?? ""))
        .join(" ");
      if (!firstUserSeen) {
        firstUserSeen = true;
        firstUserText = said;
      } else if (CORRECTION.test(said)) stats.correctionTurns++;
    }

    if (msg.role === "assistant") {
      stats.assistantTurns++;
      const modelKey = `${msg.provider ?? "?"}/${msg.model ?? "?"}`;
      stats.models[modelKey] = (stats.models[modelKey] ?? 0) + 1;
      for (const part of parts) {
        if (part?.type !== "toolCall") continue;
        stats.toolCalls++;
        const name = String(part.name ?? "?");
        const args = part.arguments ?? {};
        if (name === "bash" && typeof args.command === "string") {
          stats.commands.push(args.command);
          if (SHIPPED.test(args.command)) stats.shipped = true;
        }
        if (typeof part.id === "string" && typeof args.command === "string") {
          callCommands.set(part.id, args.command);
        }
        if ((name === "edit" || name === "write") && typeof args.path === "string") {
          stats.editedFiles.push(args.path);
        }
      }
      const usage = msg.usage;
      if (usage && typeof usage === "object") {
        stats.reasoningTokens += Number(usage.reasoning ?? 0) || 0;
        stats.outputTokens += Number(usage.output ?? 0) || 0;
        stats.totalTokens += Number(usage.totalTokens ?? 0) || 0;
        stats.costUsd += Number(usage.cost?.total ?? 0) || 0;
      }
      if (msg.stopReason === "aborted") stats.aborts++;
      if (msg.errorMessage) stats.providerErrors++;
    }

    if (msg.role === "toolResult") {
      stats.toolResults++;
      if (msg.isError === true) {
        const name = String(msg.toolName ?? "?");
        stats.failedTools[name] = (stats.failedTools[name] ?? 0) + 1;
        const resultText =
          parts.find((p) => p?.type === "text" && typeof p.text === "string")?.text ?? "";
        const probe = isProbeExit(name, callCommands.get(String(msg.toolCallId ?? "")) ?? "", String(resultText));
        if (probe) stats.probeTools[name] = (stats.probeTools[name] ?? 0) + 1;
        stats.failedCalls.push({
          tool: name,
          session: stats.id,
          at: Number.isFinite(ts) ? ts : 0,
          firstLine: firstLineOf(parts),
          probe,
        });
      }
    }
  }

  if (!stats.endedAt) stats.endedAt = fileStat.mtimeMs;
  if (!stats.startedAt) stats.startedAt = fileStat.mtimeMs;
  // Child-run transcripts are all named `session.jsonl`, so the basename carries no identity;
  // the session header's uuid is the real id (meta/sessions 2026-09-11).
  if (stats.id === "session" && headerId) stats.id = headerId;
  stats.agent = agentOf(subagentName, firstUserText);

  deriveSignals(stats);
  return stats;
}

/**
 * Signals are deliberately narrow. Each one is a concrete behaviour a reader can go and
 * verify in the transcript, because a signal nobody can audit is just a vibe with a name.
 */
function deriveSignals(s: SessionStats): void {
  // Every offender carries a per-session count, because a label tallied across sessions
  // cannot be read: "5x edit" beside one session id looked like five edits in that
  // session when it meant five sessions elsewhere. Labels that used to embed their own
  // tally (`4x path`) drop it; the count column states it once, for the session named.
  const add = (name: string, offender?: string, count = 1): void => {
    s.signals[name] = (s.signals[name] ?? 0) + 1;
    if (offender) {
      if (!s.offenders[name]) s.offenders[name] = {};
      const list = s.offenders[name];
      list[offender] = (list[offender] ?? 0) + count;
    }
  };

  // A tool's genuine failures are counted one `add` per failed call, so `tool-error Nx` keeps
  // meaning N failed calls worth diagnosing, and its offender row carries that tool's own
  // share of them. Probe exits (deliberate nonzero checks) are excluded here and tallied in
  // `totals.probeExits` instead, so a session that probes a lot is not ranked as confused.
  for (const [tool, n] of Object.entries(s.failedTools)) {
    const genuine = n - (s.probeTools[tool] ?? 0);
    for (let i = 0; i < genuine; i++) add("tool-error", tool);
  }

  // The same command re-run three times is a retry loop: either a flaky tool or a model
  // that did not read the first failure.
  const commandCounts = tally(s.commands);
  for (const [cmd, n] of commandCounts) if (n >= 3) add("repeat-command", shortCommand(cmd), n);

  const fileCounts = tally(s.editedFiles);
  for (const [path, n] of fileCounts) if (n >= 4) add("file-rework", path, n);

  if (s.aborts > 0) add("abort", "aborted turn(s)", s.aborts);
  if (s.providerErrors > 0) add("provider-error", "errorMessage turn(s)", s.providerErrors);
  if (s.correctionTurns > 0) add("owner-correction", "correction turn(s)", s.correctionTurns);

  // A session that edited files and still never committed is the factory's most expensive
  // failure mode: the tokens are gone and nothing landed. Editing is required precisely so
  // the read-only loops (triage, sweeper, scrumo, every reviewer child) are not flagged for
  // behaving as designed, and 15 tool calls is the floor below which a session was a question.
  if (s.toolCalls >= 15 && s.editedFiles.length > 0 && !s.shipped) {
    add("dead-end", `${s.toolCalls} tool calls, ${s.editedFiles.length} edits, no commit or PR`);
  }
}

function tally(items: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) out.set(item, (out.get(item) ?? 0) + 1);
  return out;
}

// ── Aggregation ────────────────────────────────────────────────────────────

interface SignalRollup {
  name: string;
  sessions: number;
  occurrences: number;
  attributedTokens: number;
  tokenShare: number;
  frictionScore: number;
  offenders: { label: string; count: number; session: string; agent: string }[];
}

interface AgentRollup {
  agent: string;
  sessions: number;
  toolCalls: number;
  failedToolCalls: number;
  probeExits: number;
  deadEnds: number;
  totalTokens: number;
  costUsd: number;
}

interface Report {
  window: { since: string; until: string; days: number };
  totals: {
    sessions: number;
    /** Transcripts that are not forks. A fork replays its parent, so it is the same session. */
    nonForkSessions: number;
    userTurns: number;
    toolCalls: number;
    failedToolCalls: number;
    probeExits: number;
    aborts: number;
    providerErrors: number;
    totalTokens: number;
    reasoningTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  agents: AgentRollup[];
  models: { model: string; turns: number; reasoningTokens: number }[];
  signals: SignalRollup[];
  /** Populated only when `--errors` is passed: the failed calls behind the ranking. */
  errors: { total: number; probes: number; calls: FailedCall[] } | null;
  subagents: { runs: number; failed: number; medianSeconds: number };
  /** Executor outcome metrics from the job ledger; null when the ledger dir is absent. */
  ledger: LedgerReport | null;
  /** Triage outcome proxy; null unless `--board`, or when gh/board state is unreadable. */
  board: BoardReport | null;
  cache: CacheReport | null;
  deltas: Record<string, number>;
  notes: string[];
}

const SIGNAL_WINDOW_FLOOR = 1; // kept named so the ranking formula reads as intended

function summarise(sessions: SessionStats[], previous: SessionStats[], cache: CacheReport | null): Report {
  const range = sessionRange(sessions);
  const totalTokens = sum(sessions, (s) => s.totalTokens);
  const totalToolCalls = sum(sessions, (s) => s.toolCalls);

  const byName = new Map<string, { sessions: Set<string>; occurrences: number; tokens: number; offenders: Map<string, { label: string; count: number; session: string; agent: string }> }>();
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.signals)) {
      const bucket = byName.get(name) ?? { sessions: new Set<string>(), occurrences: 0, tokens: 0, offenders: new Map() };
      bucket.sessions.add(s.id);
      bucket.occurrences += count;
      bucket.tokens += s.totalTokens;
      // One row per (label, session), counting that session's own hits, so the session id
      // printed beside a count is the session the count belongs to.
      for (const [label, hits] of Object.entries(s.offenders[name] ?? {})) {
        bucket.offenders.set(`${s.id}\u0000${label}`, { label, count: hits, session: s.id, agent: s.agent });
      }
      byName.set(name, bucket);
    }
  }

  const signals: SignalRollup[] = [...byName.entries()].map(([name, b]) => {
    const tokenShare = totalTokens ? b.tokens / totalTokens : 0;
    // Tokens burned in sessions showing the signal, scaled by how densely the signal fires
    // in those sessions. A signal that fires once in a cheap session ranks below one that
    // fires repeatedly in an expensive one, which is the ordering the owner needs.
    const density = b.occurrences / Math.max(SIGNAL_WINDOW_FLOOR, Math.max(1, b.sessions.size));
    return {
      name,
      sessions: b.sessions.size,
      occurrences: b.occurrences,
      attributedTokens: b.tokens,
      tokenShare,
      frictionScore: Math.round(b.tokens * density),
      offenders: [...b.offenders.values()].sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
    };
  });
  signals.sort((a, b) => b.frictionScore - a.frictionScore);

  const perModel = new Map<string, { turns: number; reasoningTokens: number }>();
  for (const s of sessions) {
    for (const [model, turns] of Object.entries(s.models)) {
      const row = perModel.get(model) ?? { turns: 0, reasoningTokens: 0 };
      row.turns += turns;
      perModel.set(model, row);
    }
    // Reasoning tokens carry no model label of their own, so the session's dominant model
    // takes them. Session-level attribution is honest; per-turn attribution is not.
    const dominant = Object.entries(s.models).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (dominant) {
      const row = perModel.get(dominant) ?? { turns: 0, reasoningTokens: 0 };
      row.reasoningTokens += s.reasoningTokens;
      perModel.set(dominant, row);
    }
  }

  const notes: string[] = [];
  if (!sessions.length) notes.push("No transcripts in the window: the factory has not run, or the session root is wrong.");
  const windowSessions = new Set(sessions.map((s) => s.id));
  const windowTokens = totalTokens;
  if (!windowTokens) notes.push("No token usage recorded in the window; cost columns will read zero.");

  const priorSessions = previous.filter((p) => !windowSessions.has(p.id));
  const priorTokens = sum(priorSessions, (p) => p.totalTokens);
  const priorSessions_withTools = priorSessions.filter((p) => p.toolCalls >= 15 && !p.shipped).length;
  const nowDeadEnds = sessions.filter((s) => s.signals["dead-end"]).length;

  // Per-loop attribution: the ranking names a loop, not a bare session id. Sessions a fork
  // replays inherit the parent's label, so a loop's numbers are not split across copies.
  const agentsMap = new Map<string, AgentRollup>();
  for (const s of sessions) {
    const row = agentsMap.get(s.agent) ?? {
      agent: s.agent,
      sessions: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      probeExits: 0,
      deadEnds: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    row.sessions++;
    row.toolCalls += s.toolCalls;
    row.failedToolCalls += Object.values(s.failedTools).reduce((a, b) => a + b, 0);
    row.probeExits += Object.values(s.probeTools).reduce((a, b) => a + b, 0);
    if (s.signals["dead-end"]) row.deadEnds++;
    row.totalTokens += s.totalTokens;
    row.costUsd += s.costUsd;
    agentsMap.set(s.agent, row);
  }
  const agents = [...agentsMap.values()].map((r) => ({ ...r, costUsd: round(r.costUsd, 4) })).sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    window: range,
    totals: {
      sessions: sessions.length,
      nonForkSessions: sessions.filter((s) => !s.fork).length,
      userTurns: sum(sessions, (s) => s.userTurns),
      toolCalls: totalToolCalls,
      failedToolCalls: sum(sessions, (s) => Object.values(s.failedTools).reduce((a, b) => a + b, 0)),
      probeExits: sum(sessions, (s) => Object.values(s.probeTools).reduce((a, b) => a + b, 0)),
      aborts: sum(sessions, (s) => s.aborts),
      providerErrors: sum(sessions, (s) => s.providerErrors),
      totalTokens,
      reasoningTokens: sum(sessions, (s) => s.reasoningTokens),
      outputTokens: sum(sessions, (s) => s.outputTokens),
      costUsd: round(sum(sessions, (s) => s.costUsd), 4),
    },
    agents,
    models: [...perModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.reasoningTokens - a.reasoningTokens),
    signals,
    subagents: subagentOutcomes(),
    ledger: null,
    board: null,
    cache,
    errors: null,
    deltas: {
      sessions: sessions.length - priorSessions.length,
      failedToolCalls:
        sum(sessions, (s) => Object.values(s.failedTools).reduce((a, b) => a + b, 0)) -
        sum(priorSessions, (p) => Object.values(p.failedTools).reduce((a, b) => a + b, 0)),
      deadEnds: nowDeadEnds - priorSessions_withTools,
      totalTokens: totalTokens - priorTokens,
    },
    notes,
  };
}

// ── Job ledger: executor outcomes ───────────────────────────────────────────

interface LedgerJobRow {
  item: number;
  title: string;
  pr: number | null;
  done: boolean;
  stages: { stage: string; attempts: number; firstTryOk: boolean }[];
  retries: number;
  spentMs: number;
  budgetMs: number;
  burnPct: number;
  updatedAt: string;
}

interface LedgerReport {
  jobs: LedgerJobRow[];
  stages: number;
  firstTryOk: number;
  retries: number;
  spentMs: number;
  budgetMs: number;
  notes: string[];
}

/**
 * A stage the model ran and succeeded at. `nochange` is the fixer's own verdict: the drainer
 * code-verifies it and advances the job, so it is a first-try pass, not a failure.
 */
const STAGE_OK = new Set(["ok", "nochange"]);

/**
 * History rows that are markers rather than attempts. `skipped` is a stage the drainer
 * bypassed (a clean review needs no fix), `retried` is the owner's `factory-jobs retry`
 * stamp. Counting either as an attempt reports a first-try failure and a retry where no
 * model ran twice.
 */
const LEDGER_MARKERS = new Set(["skipped", "retried"]);

/**
 * Executor outcome metrics from `.pi/factory/jobs/` (live jobs plus `archive/`). The
 * transcripts say how a run felt; the ledger says whether it delivered. A stage's first
 * history row decides first-try ok (the drainer blocks on a stage's second failure, so
 * retries beyond that are ledger bugs, not model behaviour); budget burn compares spent
 * wall-clock against `JOB_CAP_MS`, the ceiling the drainer clamps every stage to.
 */
export function readLedger(jobsDir: string, sinceMs: number): LedgerReport | null {
  if (!existsSync(jobsDir)) return null;
  const cutoff = Date.now() - sinceMs;
  const files: string[] = [];
  for (const dir of [join(jobsDir, "archive"), jobsDir]) {
    try {
      for (const name of readdirSync(dir)) if (name.endsWith(".json")) files.push(join(dir, name));
    } catch {
      continue;
    }
  }

  const jobs: LedgerJobRow[] = [];
  const notes: string[] = [];
  for (const file of files) {
    let job: any;
    try {
      job = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      notes.push(`Unparseable job record: ${basename(file)}`);
      continue;
    }
    const updatedAtMs = Date.parse(String(job.updatedAt ?? ""));
    const history: any[] = Array.isArray(job.history) ? job.history : [];
    const lastEndMs = history.length ? Date.parse(String(history[history.length - 1].endedAt ?? "")) : 0;
    const touchedMs = Math.max(updatedAtMs || 0, lastEndMs || 0);
    if (!Number.isFinite(touchedMs) || touchedMs < cutoff) continue;

    const byStage = new Map<string, { attempts: number; firstTryOk: boolean }>();
    for (const row of history) {
      const result = String(row.result ?? "");
      if (LEDGER_MARKERS.has(result)) continue;
      const stage = String(row.stage ?? "?");
      const entry = byStage.get(stage);
      if (!entry) byStage.set(stage, { attempts: 1, firstTryOk: STAGE_OK.has(result) });
      else entry.attempts++;
    }
    const stages = [...byStage.entries()].map(([stage, v]) => ({ stage, ...v }));
    const retries = stages.reduce((a, s) => a + Math.max(0, s.attempts - 1), 0);
    const budgetMs = JOB_CAP_MS;
    const spentMs = Number(job.spentMs ?? 0) || 0;
    jobs.push({
      item: Number(job.item ?? 0),
      title: String(job.title ?? ""),
      pr: typeof job.pr === "number" ? job.pr : null,
      done: job.stage === "done",
      stages,
      retries,
      spentMs,
      budgetMs,
      burnPct: budgetMs ? round((spentMs / budgetMs) * 100, 1) : 0,
      updatedAt: String(job.updatedAt ?? ""),
    });
  }

  if (!jobs.length) notes.push("No jobs touched the window: the executor has not run in-window.");
  jobs.sort((a, b) => a.item - b.item);
  const stagesTotal = jobs.reduce((a, j) => a + j.stages.length, 0);
  return {
    jobs,
    stages: stagesTotal,
    firstTryOk: jobs.reduce((a, j) => a + j.stages.filter((s) => s.firstTryOk).length, 0),
    retries: jobs.reduce((a, j) => a + j.retries, 0),
    spentMs: jobs.reduce((a, j) => a + j.spentMs, 0),
    // One budget per job: summing only the spend would price five jobs against one job's cap.
    budgetMs: jobs.reduce((a, j) => a + j.budgetMs, 0),
    notes,
  };
}

// ── Board staleness: triage outcomes ───────────────────────────────────────

interface BoardStaleItem {
  number: number;
  title: string;
  lastAuthor: string;
  answeredAt: string;
  ageHours: number;
  /** True once the answer has survived ≥24h: two triage passes at the 12h cadence. */
  missedPasses: boolean;
}

interface BoardReport {
  blocked: number;
  unprocessed: BoardStaleItem[];
  notes: string[];
}

/**
 * The triage outcome proxy: a Blocked item whose latest comment is the owner's is an
 * answer sitting unprocessed (the #54/#55 case — answered 07:04, sat Blocked through an
 * entire pass). The owner answers in the GitHub UI as the repo owner; loops comment as the
 * agent account, so "owner spoke last" reads as "no loop has digested the answer yet".
 * An owner answer an agent then acknowledged without acting on stays invisible to this
 * proxy — read the card, not just the count.
 */
export function unprocessedOwnerAnswer(
  comments: { author: string; createdAt: string }[],
  ownerLogin: string,
  nowMs: number,
): { lastAuthor: string; answeredAt: string; ageHours: number; missedPasses: boolean } | null {
  // Ordered here rather than trusted from the API: "the owner spoke last" is a question about
  // time, and today's `gh issue view` ordering is not part of the contract.
  const ordered = comments
    .map((c) => ({ c, at: Date.parse(c.createdAt) }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);
  const last = ordered.at(-1);
  if (!last || last.c.author.toLowerCase() !== ownerLogin.toLowerCase()) return null;
  const ageHours = (nowMs - last.at) / 3_600_000;
  return { lastAuthor: last.c.author, answeredAt: last.c.createdAt, ageHours: round(ageHours, 1), missedPasses: ageHours >= 24 };
}

function ghJson(args: string[], timeoutMs = 60_000): any | null {
  try {
    const run = spawnSync("gh", args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (run.status !== 0 || !run.stdout) {
      if (run.status !== 0) return { __ghError: String(run.stderr ?? "").trim() };
      return null;
    }
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
}

/**
 * `--board` section. Reads the board via `gh project item-list` (project id and owner from
 * `.pi/factory/project.json`), takes the Blocked items, and asks each for its comment tail
 * via `gh issue view --json comments`. Network-shaped and read-only; any gh failure lands
 * in `notes` rather than failing the whole report.
 */
function readBoardStaleness(): BoardReport | null {
  const projectPath = join(REPO_ROOT, ".pi", "factory", "project.json");
  if (!existsSync(projectPath)) return null;
  let project: any;
  try {
    project = JSON.parse(readFileSync(projectPath, "utf-8"));
  } catch {
    return { blocked: 0, unprocessed: [], notes: ["Unparseable .pi/factory/project.json"] };
  }
  const projectNumber = project?.projectNumber;
  const owner = String(project?.owner ?? "");
  const repo = String(project?.repo ?? "");
  if (!projectNumber || !owner) return { blocked: 0, unprocessed: [], notes: ["project.json lacks projectNumber/owner"] };

  const notes: string[] = [];
  const listing = ghJson(["project", "item-list", String(projectNumber), "--owner", owner, "--format", "json", "--limit", "300"]);
  if (!listing || listing.__ghError || !Array.isArray(listing.items)) {
    notes.push(`gh project item-list failed: ${listing?.__ghError ?? "no output"}`);
    return { blocked: 0, unprocessed: [], notes };
  }

  const blockedItems = listing.items.filter(
    (it: any) => it?.status === "Blocked" && String(it?.content?.type ?? "").toLowerCase() === "issue",
  );
  const now = Date.now();
  const unprocessed: BoardStaleItem[] = [];
  const ownerLogin = repo.split("/")[0] || owner;
  // One `gh issue view` per item: bounded rather than unbounded, and said out loud when the
  // bound bites, because a report that silently under-counts is worse than a slow one.
  const scanned = blockedItems.slice(0, 40);
  if (scanned.length < blockedItems.length) {
    notes.push(`Board truncated: ${blockedItems.length} Blocked items, the first ${scanned.length} checked for an unprocessed answer`);
  }
  for (const it of scanned) {
    const number = Number(it.content?.number ?? 0);
    const title = String(it.content?.title ?? "");
    if (!number) continue;
    const detail = ghJson(["issue", "view", String(number), "--repo", repo, "--json", "comments"]);
    if (!detail || detail.__ghError || !Array.isArray(detail.comments)) {
      notes.push(`gh issue view #${number} failed: ${detail?.__ghError ?? "no output"}`);
      continue;
    }
    const comments = detail.comments.map((c: any) => ({ author: String(c?.author?.login ?? ""), createdAt: String(c?.createdAt ?? "") }));
    const pending = unprocessedOwnerAnswer(comments, ownerLogin, now);
    if (pending) {
      unprocessed.push({ number, title, ...pending });
    }
  }
  unprocessed.sort((a, b) => b.ageHours - a.ageHours);
  return { blocked: blockedItems.length, unprocessed, notes };
}


interface RouteCost {
  input: number;
  cacheRead: number;
  output: number;
}

interface CacheRoute {
  route: string;
  modelName: string;
  requests: number;
  hitRequests: number;
  requestHitRate: number;
  inputTokens: number;
  cachedTokens: number;
  tokenHitRate: number;
  fullPriceTokens: number;
  headlinePerM: number | null;
  effectivePerM: number | null;
  /** Cost above the perfect-cache floor: what the cache misses actually billed. */
  missPremiumUsd: number | null;
}

interface CacheReport {
  shards: number;
  days: string[];
  routes: CacheRoute[];
  notes: string[];
}

/**
 * Reads the `pi-cache-optimizer` shards: per-process, atomically written cache counters split
 * by provider/model. They are a better source than the transcripts for two reasons: they
 * distinguish a request that hit *anything* from a request that hit everything, and they
 * carry the model's cost table lookup, which is what turns a hit rate into money.
 *
 * They are also NOT project-scoped: `sessionHash` is opaque and there is no cwd, so this
 * section is estate-wide even when the transcript half of the report is one repo. Saying so
 * matters more than the tidier output a silent merge would produce.
 */
function readCacheReport(dir: string, sinceMs: number): CacheReport | null {
  if (!existsSync(dir)) return null;
  const cutoffDay = new Date(Date.now() - sinceMs).toISOString().slice(0, 10);
  const costs = loadModelCosts();
  const routes = new Map<string, CacheRoute>();
  const days = new Set<string>();
  let shards = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let shard: any;
    try {
      shard = JSON.parse(readFileSync(join(dir, name), "utf-8"));
    } catch {
      continue;
    }
    const day = String(shard?.day ?? "");
    if (day && day < cutoffDay) continue;
    shards++;
    if (day) days.add(day);

    for (const [route, body] of Object.entries<any>(shard?.models ?? {})) {
      const stats = body?.stats ?? {};
      const row = routes.get(route) ?? {
        route,
        modelName: String(body?.modelName ?? route),
        requests: 0,
        hitRequests: 0,
        requestHitRate: 0,
        inputTokens: 0,
        cachedTokens: 0,
        tokenHitRate: 0,
        fullPriceTokens: 0,
        headlinePerM: null,
        effectivePerM: null,
        missPremiumUsd: null,
      };
      row.requests += Number(stats.totalRequests ?? 0) || 0;
      row.hitRequests += Number(stats.hitRequests ?? 0) || 0;
      row.inputTokens += Number(stats.totalInputTokens ?? 0) || 0;
      row.cachedTokens += Number(stats.cachedInputTokens ?? 0) || 0;
      routes.set(route, row);

      const cost = costs.get(`${body?.provider ?? ""}/${body?.modelId ?? ""}`) ?? costs.get(route);
      if (cost && cost.input > 0) {
        row.headlinePerM = cost.input;
        // The whole point of the column: a route with a cheap headline price and a poor hit
        // rate can cost more per useful token than an expensive one that caches well.
        row.effectivePerM =
          (row.inputTokens * cost.input * (1 - row.tokenHitRate) + row.cachedTokens * cost.cacheRead) /
          (row.inputTokens || 1);
        row.missPremiumUsd = (row.fullPriceTokens * (cost.input - cost.cacheRead)) / 1_000_000;
      }
    }
  }

  for (const row of routes.values()) {
    row.fullPriceTokens = Math.max(0, row.inputTokens - row.cachedTokens);
    row.requestHitRate = row.requests ? row.hitRequests / row.requests : 0;
    row.tokenHitRate = row.inputTokens ? row.cachedTokens / row.inputTokens : 0;
    const cost = costs.get(row.route);
    if (cost && cost.input > 0 && row.inputTokens) {
      row.effectivePerM =
        (row.fullPriceTokens * cost.input + row.cachedTokens * cost.cacheRead) / row.inputTokens;
      row.missPremiumUsd = (row.fullPriceTokens * (cost.input - cost.cacheRead)) / 1_000_000;
    }
  }

  const notes: string[] = [];
  if (!shards) notes.push("No cache shards in the window: pi-cache-optimizer has not recorded a run.");
  notes.push(
    "Cache shards are estate-wide, not repo-scoped (sessionHash is opaque, there is no cwd), so these " +
      "numbers include every project on this machine.",
  );
  notes.push(
    "Prefix churn is not visible here: every shard reports its epoch as `initial:*`, so a fresh epoch " +
      "cannot be told from a warm one. Use the per-session full-price input above as the proxy instead.",
  );
  notes.push(
    "cacheWrite is zero in every shard, so caching is provider-side and implicit; write cost is invisible.",
  );

  return {
    shards,
    days: [...days].sort(),
    routes: [...routes.values()].sort((a, b) => b.fullPriceTokens - a.fullPriceTokens),
    notes,
  };
}

/** Cost tables come from the same store pi resolves models through, so prices cannot drift. */
function loadModelCosts(): Map<string, RouteCost> {
  const out = new Map<string, RouteCost>();
  const path = join(homedir(), ".pi", "agent", "models-store.json");
  if (!existsSync(path)) return out;
  try {
    const store = JSON.parse(readFileSync(path, "utf-8"));
    for (const [provider, body] of Object.entries<any>(store)) {
      for (const model of body?.models ?? []) {
        const cost = model?.cost;
        if (!cost || typeof cost.input !== "number") continue;
        const entry: RouteCost = {
          input: cost.input,
          cacheRead: Number(cost.cacheRead ?? 0) || 0,
          output: Number(cost.output ?? 0) || 0,
        };
        out.set(`${provider}/${model.id}`, entry);
        if (provider === "openrouter") out.set(String(model.id), entry);
      }
    }
  } catch {
    return out;
  }
  return out;
}

function sessionRange(sessions: SessionStats[]): Report["window"] {
  if (!sessions.length) return { since: "n/a", until: "n/a", days: 0 };
  const start = Math.min(...sessions.map((s) => s.startedAt));
  const end = Math.max(...sessions.map((s) => s.endedAt));
  return {
    since: new Date(start).toISOString(),
    until: new Date(end).toISOString(),
    days: round((end - start) / 86_400_000, 2),
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Subagent runs are the factory's other half of the evidence: durations and failures. */
function subagentOutcomes(): Report["subagents"] {
  const path = join(homedir(), ".pi", "agent", "run-history.jsonl");
  if (!existsSync(path)) return { runs: 0, failed: 0, medianSeconds: 0 };
  const durations: number[] = [];
  let failed = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (typeof row.duration === "number") durations.push(row.duration / 1000);
      if (row.outcome === "failed" || row.status === "error") failed++;
    } catch {
      continue;
    }
  }
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  return { runs: durations.length, failed, medianSeconds: round(median, 1) };
}

// ── Output ─────────────────────────────────────────────────────────────────

function renderText(report: Report, top: number): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(`Factory friction — ${report.window.since.slice(0, 10)} to ${report.window.until.slice(0, 10)} (${report.window.days}d)`);
  lines.push(
    `${t.sessions} sessions, ${t.userTurns} owner turns, ${t.toolCalls} tool calls (${t.failedToolCalls} failed, ` +
      `${t.probeExits} probe exits), ${formatTokens(t.totalTokens)} tokens (${formatTokens(t.reasoningTokens)} reasoning, ` +
      `${formatTokens(t.outputTokens)} output), $${t.costUsd}`,
  );
  const d = report.deltas;
  lines.push(
    `vs previous window: sessions ${signed(d.sessions)}, failed tool calls ${signed(d.failedToolCalls)}, ` +
      `dead ends ${signed(d.deadEnds)}, tokens ${signed(d.totalTokens)}`,
  );
  lines.push("");

  lines.push("Ranked friction signals (proxy: tokens burned in sessions showing the signal, scaled by signal density)");
  if (!report.signals.length) lines.push("  none");
  for (const [i, sig] of report.signals.slice(0, top).entries()) {
    lines.push(
      `  ${i + 1}. ${sig.name} — ${sig.occurrences}x in ${sig.sessions} session(s), ` +
        `${(sig.tokenShare * 100).toFixed(0)}% of window tokens, score ${sig.frictionScore}`,
    );
    for (const off of sig.offenders.slice(0, 3)) {
      lines.push(`       ${off.count}x  ${off.label}  [${off.session.slice(0, 28)} · ${off.agent}]`);
    }
  }
  lines.push("");

  lines.push("By loop (sessions attributed by subagent name, else scheduler brief, else interactive)");
  if (!report.agents.length) lines.push("  none");
  for (const a of report.agents) {
    lines.push(
      `  ${a.agent}: ${a.sessions} session(s), ${a.toolCalls} tool calls (${a.failedToolCalls} failed, ${a.probeExits} probes), ` +
        `${formatTokens(a.totalTokens)} tokens, $${a.costUsd}, ${a.deadEnds} dead-end(s)`,
    );
  }
  lines.push("");

  if (report.errors) {
    const { total, probes, calls } = report.errors;
    lines.push(`Failed tool calls (newest ${calls.length} of ${total}; ${probes} probe exits marked and unranked)`);
    for (const [i, call] of calls.entries()) {
      const marker = call.probe ? "[probe] " : "";
      lines.push(`  ${i + 1}. ${marker}${call.tool}  [${call.session.slice(0, 36)}]  ${call.firstLine}`);
    }
    lines.push("");
  }

  if (report.ledger) {
    const l = report.ledger;
    lines.push(`Job ledger — executor outcomes (${l.jobs.length} job(s) touched the window)`);
    if (!l.jobs.length) {
      lines.push("  none");
    } else {
      const pct = l.stages ? Math.round((l.firstTryOk / l.stages) * 100) : 0;
      lines.push(
        `  stages: ${l.stages}, first-try ok ${l.firstTryOk} (${pct}%), retries ${l.retries}, ` +
          `budget burn ${(l.budgetMs ? round((l.spentMs / l.budgetMs) * 100, 1) : 0)}%`,
      );
      for (const j of l.jobs) {
        const pr = j.pr ? `, PR #${j.pr}` : "";
        lines.push(
          `  #${j.item} ${j.title.slice(0, 48)} — ${j.stages.length} stage(s), ${j.retries} retry(s), ` +
            `${(j.spentMs / 60_000).toFixed(1)}m of ${(j.budgetMs / 60_000).toFixed(0)}m (${j.burnPct}%)${pr}, ${j.done ? "done" : "not done"}`,
        );
      }
    }
    for (const note of l.notes) lines.push(`  NOTE: ${note}`);
    lines.push("");
  }

  if (report.board) {
    const b = report.board;
    lines.push(`Board staleness — Blocked items with an unprocessed owner answer (blocked: ${b.blocked})`);
    if (!b.unprocessed.length) {
      lines.push("  none: every Blocked item was either never answered or spoken to last by a loop");
    }
    for (const item of b.unprocessed) {
      const flag = item.missedPasses ? " — MISSED ≥2 PASSES (12h cadence)" : "";
      lines.push(`  #${item.number} ${item.title.slice(0, 48)} — owner answered ${item.answeredAt} (${item.ageHours}h old)${flag}`);
    }
    for (const note of b.notes) lines.push(`  NOTE: ${note}`);
    lines.push("");
  }

  lines.push("Reasoning tokens by model");
  for (const m of report.models.slice(0, 6)) {
    lines.push(`  ${m.model}: ${formatTokens(m.reasoningTokens)} reasoning over ${m.turns} turns`);
  }
  lines.push("");

  const forks = report.totals.sessions - report.totals.nonForkSessions;
  const sa = report.subagents;
  lines.push(`Subagent runs: ${sa.runs} recorded, ${sa.failed} failed, median ${sa.medianSeconds}s`);
  lines.push(`Sessions: ${report.totals.nonForkSessions} non-fork, ${forks} fork(s)`);
  lines.push("");

  if (report.cache) {
    lines.push(`Cache economy (${report.cache.shards} shards, ${report.cache.days.join(" ")})`);
    lines.push(
      "  route                                            reqs   req-hit  tok-hit    full-price   $/M head   $/M eff   miss $",
    );
    for (const r of report.cache.routes.slice(0, 8)) {
      const head = r.headlinePerM === null ? "n/a" : r.headlinePerM.toFixed(3);
      const eff = r.effectivePerM === null ? "n/a" : r.effectivePerM.toFixed(4);
      const premium = r.missPremiumUsd === null ? "n/a" : `$${r.missPremiumUsd.toFixed(2)}`;
      lines.push(
        `  ${r.route.slice(0, 46).padEnd(46)} ${String(r.requests).padStart(4)} ` +
          `${(r.requestHitRate * 100).toFixed(0).padStart(8)}% ${(r.tokenHitRate * 100).toFixed(1).padStart(8)}% ` +
          `${formatTokens(r.fullPriceTokens).padStart(12)} ${head.padStart(10)} ${eff.padStart(9)} ${premium.padStart(8)}`,
      );
    }
    lines.push("  ($/M eff weights cached tokens at the cache-read rate; miss $ is the premium paid above a perfect-cache floor)");
    for (const note of report.cache.notes) lines.push(`  NOTE: ${note}`);
    lines.push("");
  }

  for (const note of report.notes) lines.push(`NOTE: ${note}`);
  return lines.join("\n");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.sessionsRoot)) {
    console.error(`Session root not found: ${opts.sessionsRoot}`);
    process.exit(1);
  }

  const folders = opts.allProjects
    ? readdirSync(opts.sessionsRoot).filter((d) => !d.startsWith("."))
    : opts.projectDir
      ? [opts.projectDir]
      : projectFolderCandidates(opts.sessionsRoot);

  const files: string[] = [];
  for (const folder of folders) files.push(...collectTranscripts(join(opts.sessionsRoot, folder)));

  const now = Date.now();
  const cutoff = now - opts.sinceMs;
  const priorCutoff = cutoff - opts.sinceMs;

  const idCache = new Map<string, Set<string>>();
  const all = files.map((f) => readSession(f, ancestorEntryIds(f, idCache))).filter((s) => s.toolCalls > 0);
  const current = all.filter((s) => s.endedAt >= cutoff);
  const previous = all.filter((s) => s.endedAt >= priorCutoff && s.endedAt < cutoff);

  const report = summarise(current, previous, readCacheReport(opts.cacheShards, opts.sinceMs));
  report.ledger = readLedger(opts.jobsDir, opts.sinceMs);
  if (opts.board) {
    report.board = readBoardStaleness();
  } else {
    report.notes.push("Board staleness not computed: pass --board (needs gh and .pi/factory/project.json).");
  }
  if (opts.errors > 0) {
    const window = current.flatMap((s) => s.failedCalls).sort((a, b) => b.at - a.at);
    report.errors = {
      total: window.length,
      probes: window.filter((c) => c.probe).length,
      calls: window.slice(0, opts.errors),
    };
  }
  if (opts.json) {
    console.log(JSON.stringify({ ...report, sources: { root: opts.sessionsRoot, folders, files: files.length } }, null, 2));
    return;
  }
  console.log(renderText(report, opts.top));
}

// Tests import the pure helpers above; only a direct `tsx scripts/factory-friction.ts` run executes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
