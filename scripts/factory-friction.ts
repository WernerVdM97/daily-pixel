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
// Usage:
//   tsx scripts/factory-friction.ts                     # last 7 days, text brief
//   tsx scripts/factory-friction.ts --since 3d --top 8
//   tsx scripts/factory-friction.ts --json              # full structured report
//   tsx scripts/factory-friction.ts --sessions ~/.pi/agent/sessions --all-projects

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Options ────────────────────────────────────────────────────────────────

interface Options {
  sessionsRoot: string;
  projectDir: string | null;
  allProjects: boolean;
  cacheShards: string;
  sinceMs: number;
  top: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    sessionsRoot: join(homedir(), ".pi", "agent", "sessions"),
    projectDir: null,
    allProjects: false,
    cacheShards: join(homedir(), ".pi", "agent", "pi-cache-optimizer-stats.d", "shards"),
    sinceMs: 7 * 24 * 60 * 60 * 1000,
    top: 5,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sessions") opts.sessionsRoot = resolve(argv[++i]);
    else if (a === "--project") opts.projectDir = argv[++i];
    else if (a === "--all-projects") opts.allProjects = true;
    else if (a === "--cache-shards") opts.cacheShards = resolve(argv[++i]);
    else if (a === "--since") opts.sinceMs = parseSpan(argv[++i]);
    else if (a === "--top") opts.top = Number.parseInt(argv[++i], 10);
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") {
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
      "  --top <n>          instances listed per signal (default: 5)",
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

// ── Reading one transcript ─────────────────────────────────────────────────

interface SessionStats {
  file: string;
  id: string;
  fork: boolean;
  startedAt: number;
  endedAt: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  toolResults: number;
  failedTools: Record<string, number>;
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
  offenders: Record<string, string[]>;
}

const CORRECTION = /^\s*(no\b|nope|not\b|actually|wait\b|stop\b|wrong|that'?s (not|wrong)|still (broken|failing)|didn'?t work|revert|undo|again\b)/i;
const SHIPPED = /git commit|gh pr create|gh pr merge/i;

function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 110 ? `${one.slice(0, 107)}...` : one;
}

function readSession(file: string): SessionStats {
  const stats: SessionStats = {
    file,
    id: basename(file).replace(/\.jsonl$/, ""),
    fork: file.includes("/forks/"),
    startedAt: 0,
    endedAt: 0,
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolResults: 0,
    failedTools: {},
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

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // A truncated final line in a live session is expected, not an error.
    }

    const ts = Date.parse(entry?.timestamp ?? "");
    if (Number.isFinite(ts)) {
      if (!stats.startedAt || ts < stats.startedAt) stats.startedAt = ts;
      if (ts > stats.endedAt) stats.endedAt = ts;
    }
    if (entry?.type !== "message") continue;
    const msg = entry.message ?? {};
    const parts: any[] = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === "user") {
      stats.userTurns++;
      const said = parts
        .filter((p) => p?.type === "text")
        .map((p) => String(p.text ?? ""))
        .join(" ");
      if (!firstUserSeen) firstUserSeen = true;
      // Only turns after the opening brief can be a correction: the first message is the task.
      else if (CORRECTION.test(said)) stats.correctionTurns++;
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
      }
    }
  }

  if (!stats.endedAt) stats.endedAt = fileStat.mtimeMs;
  if (!stats.startedAt) stats.startedAt = fileStat.mtimeMs;

  deriveSignals(stats);
  return stats;
}

/**
 * Signals are deliberately narrow. Each one is a concrete behaviour a reader can go and
 * verify in the transcript, because a signal nobody can audit is just a vibe with a name.
 */
function deriveSignals(s: SessionStats): void {
  const add = (name: string, offender?: string): void => {
    s.signals[name] = (s.signals[name] ?? 0) + 1;
    if (offender) {
      const list = (s.offenders[name] ??= []);
      if (!list.includes(offender)) list.push(offender);
    }
  };

  const failed = Object.values(s.failedTools).reduce((a, b) => a + b, 0);
  for (let i = 0; i < failed; i++) {
    add("tool-error", Object.entries(s.failedTools).sort((a, b) => b[1] - a[1])[0]?.[0]);
  }

  // The same command re-run three times is a retry loop: either a flaky tool or a model
  // that did not read the first failure.
  const commandCounts = tally(s.commands);
  for (const [cmd, n] of commandCounts) if (n >= 3) add("repeat-command", `${n}x ${shortCommand(cmd)}`);

  const fileCounts = tally(s.editedFiles);
  for (const [path, n] of fileCounts) if (n >= 4) add("file-rework", `${n}x ${path}`);

  if (s.aborts > 0) add("abort", `${s.aborts} aborted turn(s)`);
  if (s.providerErrors > 0) add("provider-error", `${s.providerErrors} errorMessage turn(s)`);
  if (s.correctionTurns > 0) add("owner-correction", `${s.correctionTurns} correction turn(s)`);

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
  offenders: { label: string; count: number; session: string }[];
}

interface Report {
  window: { since: string; until: string; days: number };
  totals: {
    sessions: number;
    ownerSessions: number;
    userTurns: number;
    toolCalls: number;
    failedToolCalls: number;
    aborts: number;
    providerErrors: number;
    totalTokens: number;
    reasoningTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  models: { model: string; turns: number; reasoningTokens: number }[];
  signals: SignalRollup[];
  subagents: { runs: number; failed: number; medianSeconds: number };
  cache: CacheReport | null;
  deltas: Record<string, number>;
  notes: string[];
}

const SIGNAL_WINDOW_FLOOR = 1; // kept named so the ranking formula reads as intended

function summarise(sessions: SessionStats[], previous: SessionStats[], cache: CacheReport | null): Report {
  const range = sessionRange(sessions);
  const totalTokens = sum(sessions, (s) => s.totalTokens);
  const totalToolCalls = sum(sessions, (s) => s.toolCalls);

  const byName = new Map<string, { sessions: Set<string>; occurrences: number; tokens: number; offenders: Map<string, { count: number; session: string }> }>();
  for (const s of sessions) {
    for (const [name, count] of Object.entries(s.signals)) {
      const bucket = byName.get(name) ?? { sessions: new Set<string>(), occurrences: 0, tokens: 0, offenders: new Map() };
      bucket.sessions.add(s.id);
      bucket.occurrences += count;
      bucket.tokens += s.totalTokens;
      for (const label of s.offenders[name] ?? []) {
        const prior = bucket.offenders.get(label);
        if (prior) prior.count++;
        else bucket.offenders.set(label, { count: 1, session: s.id });
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
      offenders: [...b.offenders.entries()]
        .map(([label, v]) => ({ label, count: v.count, session: v.session }))
        .sort((x, y) => y.count - x.count),
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

  return {
    window: range,
    totals: {
      sessions: sessions.length,
      ownerSessions: sessions.filter((s) => !s.fork).length,
      userTurns: sum(sessions, (s) => s.userTurns),
      toolCalls: totalToolCalls,
      failedToolCalls: sum(sessions, (s) => Object.values(s.failedTools).reduce((a, b) => a + b, 0)),
      aborts: sum(sessions, (s) => s.aborts),
      providerErrors: sum(sessions, (s) => s.providerErrors),
      totalTokens,
      reasoningTokens: sum(sessions, (s) => s.reasoningTokens),
      outputTokens: sum(sessions, (s) => s.outputTokens),
      costUsd: round(sum(sessions, (s) => s.costUsd), 4),
    },
    models: [...perModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.reasoningTokens - a.reasoningTokens),
    signals,
    subagents: subagentOutcomes(),
    cache,
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
    `${t.sessions} sessions, ${t.userTurns} owner turns, ${t.toolCalls} tool calls (${t.failedToolCalls} failed), ` +
      `${formatTokens(t.totalTokens)} tokens (${formatTokens(t.reasoningTokens)} reasoning, ${formatTokens(t.outputTokens)} output), $${t.costUsd}`,
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
      lines.push(`       ${off.count}x  ${off.label}  [${off.session.slice(0, 28)}]`);
    }
  }
  lines.push("");

  lines.push("Reasoning tokens by model");
  for (const m of report.models.slice(0, 6)) {
    lines.push(`  ${m.model}: ${formatTokens(m.reasoningTokens)} reasoning over ${m.turns} turns`);
  }
  lines.push("");

  const forks = report.totals.sessions - report.totals.ownerSessions;
  const sa = report.subagents;
  lines.push(`Subagent runs: ${sa.runs} recorded, ${sa.failed} failed, median ${sa.medianSeconds}s`);
  lines.push(`Sessions: ${report.totals.ownerSessions} owner, ${forks} child/agent`);
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

  const all = files.map(readSession).filter((s) => s.toolCalls > 0);
  const current = all.filter((s) => s.endedAt >= cutoff);
  const previous = all.filter((s) => s.endedAt >= priorCutoff && s.endedAt < cutoff);

  const report = summarise(current, previous, readCacheReport(opts.cacheShards, opts.sinceMs));
  if (opts.json) {
    console.log(JSON.stringify({ ...report, sources: { root: opts.sessionsRoot, folders, files: files.length } }, null, 2));
    return;
  }
  console.log(renderText(report, opts.top));
}

main();
