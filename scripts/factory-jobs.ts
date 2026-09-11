// The Dark Factory job ledger — spec: docs/engine/dark-factory-job-ledger.md
//
// The executor's first headless run died at exactly 30:00, because the launcher's
// `TimeoutStartSec` was the only deadline in the chain: it had committed at 20 minutes,
// was killed during its final verify, opened no PR, left the item `In Progress`, and its
// post-review fixes went with the cleaned-up worktree. Three shapes caused that, and none
// of them was a prompt problem — a chain of stages inside one process has a total budget of
// min(stage budgets), state lived in the process so a crash lost every stage downstream, and
// the two steps with no model in them (opening the PR, moving the card) were prose in a
// prompt rather than code.
//
// So one board item becomes a tracked *job*: machine-readable state under
// `.pi/factory/jobs/<item>.json`, written by code, one stage per process, its own timeout
// and its own slice of a 100-minute budget. This file is that ledger and its CLI.
//
//   start            claim or adopt an item, create the worktree, leave the job at `build`
//   drain            the tick's one action: reap an orphan, block a spent job, run a stage
//   retry <item>     the owner's unblock, and the only path that refreshes the budget
//   list|show|stale  read-only, for humans
//
// Usage:
//   npx tsx scripts/factory-jobs.ts start
//   npx tsx scripts/factory-jobs.ts drain
//   npx tsx scripts/factory-jobs.ts retry 34
//   npx tsx scripts/factory-jobs.ts list | show 34 | stale
//
//   FACTORY_DRY_RUN=1        decide and log, spawn nothing, write nothing to the board
//   FACTORY_JOBS_DIR=<dir>   a scratch ledger (dry runs, tests) instead of the real one
//
// Every command that writes a record takes the drain lock first: a non-blocking lock file
// under the jobs dir, held for the whole command, the running stage included. The lock is
// what replaces a heartbeat — a drain that is executing has already proven no other drainer
// is alive, so a record that still says `running` was left by a dead one, and the only open
// question is whether its child survived it (see § Liveness).

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── The shape of a job ─────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

export type StageName = "build" | "review" | "fix" | "deliver" | "reconcile" | "done";
export type StageKind = "model" | "code";
/** `waiting` is a reconcile whose PR is still open: re-runnable, but charged nothing. */
export type StageState = "ready" | "running" | "blocked" | "waiting";

export interface StageSpec {
  kind: StageKind;
  /** The `.pi/agents/` definition that runs a model stage. Code stages have no agent. */
  agent?: string;
  budgetMs: number;
}

const MIN = 60_000;

/** Build 50 / review 20 / fix 30 the three code stages are seconds, not minutes. */
export const STAGES: Record<StageName, StageSpec> = {
  build: { kind: "model", agent: "delegate-executor", budgetMs: 50 * MIN },
  review: { kind: "model", agent: "delegate-reviewer", budgetMs: 20 * MIN },
  fix: { kind: "model", agent: "delegate-fixer", budgetMs: 30 * MIN },
  deliver: { kind: "code", budgetMs: MIN },
  reconcile: { kind: "code", budgetMs: MIN },
  done: { kind: "code", budgetMs: MIN },
};

const STAGE_ORDER: StageName[] = ["build", "review", "fix", "deliver", "reconcile", "done"];

/** Hard cumulative cap per job. Never refunded, never exceeded — see docs § Stages. */
export const JOB_CAP_MS = 100 * MIN;
/** A third attempt at one stage is blocked rather than run: two failures is a pattern. */
export const MAX_ATTEMPTS = 2;
/** A PR open this long is "waiting" that wants a human's attention. `stale` prints it. */
export const WAITING_STALE_MS = 7 * 24 * 60 * MIN;
/** The integration branch every job forks from and PRs to. */
export const BASE_REF = "dev";
/**
 * The same branch as git tracks it. Jobs fork from this, not from the local `dev` ref:
 * the local ref only moves when a human pulls, and a stale fork point is invisible until
 * the PR turns out to be based on week-old work. `baseRef: "dev"` stays in the record
 * because that is the name GitHub resolves server-side.
 */
export const UPSTREAM_REF = `origin/${BASE_REF}`;
/** Never pruned: the integration branch itself, and the release line. */
const PROTECTED_BRANCHES = new Set([BASE_REF, "main", "master"]);

export type StageResult =
  | "ok"
  | "nochange"
  | "waiting"
  | "skipped"
  | "retried"
  | "failed"
  | "timeout"
  | "reaped";

export interface HistoryEntry {
  stage: StageName;
  startedAt: string;
  endedAt: string;
  result: StageResult;
  /** Process exit code for a model stage, null for a code stage or a reap. */
  exit: number | null;
  spentMs: number;
}

export interface Claim {
  pid: number;
  /** The kernel's process start time, so a recycled pid cannot be mistaken for a live one. */
  pidStart: string | null;
}

export interface JobRecord {
  schemaVersion: number;
  item: number;
  title: string;
  priority: string | null;
  milestone: string | null;
  branch: string;
  worktree: string;
  baseRef: string;
  stage: StageName;
  stageState: StageState;
  /** Failed attempts per stage. A running attempt is not counted until it fails. */
  attempts: Partial<Record<StageName, number>>;
  spentMs: number;
  claim: Claim | null;
  /** When the running attempt started, so a reap or a crash charges the right slice. */
  stageStartedAt?: string;
  artifacts: Partial<Record<StageName, string>>;
  pr: number | null;
  /** Set only when the block's DM actually went out, so a failed page is retried. */
  pagedAt?: string;
  adoptedFrom?: { branch: string; commit: string | null; mergedDev?: string };
  waitingSince?: string;
  startedAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export function nextStage(stage: StageName): StageName | null {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx === -1 || idx === STAGE_ORDER.length - 1 ? null : STAGE_ORDER[idx + 1];
}

export function remainingMs(job: JobRecord): number {
  return Math.max(0, JOB_CAP_MS - job.spentMs);
}

/**
 * The adaptive attempt timeout: a retry of one stage never spends more than what is left, so
 * the job total cannot cross the cap. No floor here — a floor would let the last attempt
 * overshoot it by that floor, which the spec's "never crosses 100 minutes" forbids.
 */
export function attemptTimeoutMs(job: JobRecord): number {
  return Math.max(0, Math.min(STAGES[job.stage].budgetMs, remainingMs(job)));
}

// ── The decision the drainer makes each tick ───────────────────────────────

/** The kernel's view of a pid, injected so the state machine is testable without processes. */
export interface Liveness {
  /** `/proc/<pid>/stat` field 22, or null when the pid does not exist (or is not readable). */
  startTime(pid: number): string | null;
}

export type ClaimProbe = "none" | "live" | "dead" | "recycled";

/**
 * Only a matching start time proves a pid is ours. A live pid with a different one is a
 * recycled number, and a reboot reads the same way — both count the attempt and never kill.
 */
export function probeClaim(claim: Claim | null, live: Liveness): ClaimProbe {
  if (!claim) return "none";
  const start = live.startTime(claim.pid);
  if (start === null) return "dead";
  // Recorded on a platform without /proc: unverifiable, so treat it as not ours.
  if (claim.pidStart === null) return "recycled";
  return start === claim.pidStart ? "live" : "recycled";
}

export type Action =
  | { kind: "reap"; reason: string }
  | { kind: "requeue"; reason: string }
  | { kind: "block"; reason: string }
  | { kind: "page"; reason: string }
  | { kind: "run"; timeoutMs: number }
  | { kind: "skip"; reason: string };

/** Local cleanup after a merge: cheap, idempotent, and never worth blocking a merged item. */
const NEVER_BLOCKS: StageName[] = ["done"];

/**
 * The cap bounds *model* spend. A code stage is seconds, and `deliver` is the step whose
 * absence lost #34, so the cap never blocks one: a job that spent its whole budget getting
 * build/review/fix right still gets its PR. Code stages keep the attempts guard.
 */
function capExempt(stage: StageName): boolean {
  return STAGES[stage].kind === "code";
}

export function decide(job: JobRecord, live: Liveness): Action {
  if (job.stageState === "blocked") {
    return job.pagedAt
      ? { kind: "skip", reason: "already blocked and paged" }
      : { kind: "page", reason: "blocked, but the page never went out" };
  }
  // Waiting jobs are checked directly by the drain, so they never starve the others.
  if (job.stageState === "waiting") return { kind: "skip", reason: "waiting on the merge" };
  if (job.stageState === "running") {
    const probe = probeClaim(job.claim, live);
    if (probe === "live") {
      return { kind: "reap", reason: "stage process outlived the drainer that owned it" };
    }
    return {
      kind: "requeue",
      reason: probe === "recycled" ? "claim pid was recycled; the stage is gone" : "stage died with its drainer",
    };
  }
  if ((job.attempts[job.stage] ?? 0) >= MAX_ATTEMPTS && !NEVER_BLOCKS.includes(job.stage)) {
    return { kind: "block", reason: `${job.stage} failed twice` };
  }
  if (job.spentMs >= JOB_CAP_MS && !capExempt(job.stage)) {
    return { kind: "block", reason: `spent the ${Math.round(JOB_CAP_MS / MIN)} minute cap` };
  }
  return { kind: "run", timeoutMs: attemptTimeoutMs(job) };
}

/** The verdict line a review stage must start its findings file with. */
export function parseVerdict(text: string): "clean" | "findings" | "ok" | "nochange" {
  const first = text.trimStart().split("\n", 1)[0] ?? "";
  const match = /VERDICT:\s*(clean|findings|ok|nochange)\b/i.exec(first);
  // Anything else reads as `findings`: the safe default is to assume there is work to do.
  if (!match) return "findings";
  return match[1]!.toLowerCase() as "clean" | "findings" | "ok" | "nochange";
}

// ── Paths and root resolution ──────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; timeoutMs?: number },
) => ExecResult;

const defaultExec: Exec = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    const err = res.error as NodeJS.ErrnoException & { code?: string };
    return {
      code: 127,
      stdout: res.stdout ?? "",
      stderr: String(err.message ?? err),
      timedOut: err.code === "ETIMEDOUT",
    };
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

/**
 * The canonical checkout, never a linked worktree of it: the starter can be spawned inside
 * a managed worktree, and so can this script, but the ledger and the jobs it spawns all
 * belong to the main checkout. `git-common-dir` answers both cases with one code path.
 */
export function resolveRepoRoot(opts: { env?: NodeJS.ProcessEnv; exec?: Exec } = {}): string {
  const env = opts.env ?? process.env;
  const configured = env.FACTORY_PROJECT_DIR;
  if (configured && configured.trim()) return resolve(configured.trim());
  const exec = opts.exec ?? defaultExec;
  const res = exec("git", ["-C", SCRIPT_ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const common = res.stdout.trim();
  if (res.code === 0 && common.endsWith("/.git")) return dirname(common);
  return SCRIPT_ROOT;
}

export function jobsDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FACTORY_JOBS_DIR;
  if (configured && configured.trim()) return resolve(configured.trim());
  return resolve(root, ".pi/factory/jobs");
}

export function worktreeRootFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FACTORY_WORKTREE_DIR;
  if (configured && configured.trim()) return resolve(configured.trim());
  return resolve(homedir(), "projects/worktrees", basename(root));
}

/** `feat/34-last-stand-emojis-combat-frame`, the repo's branch convention. */
export function branchFor(item: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug ? `feat/${item}-${slug}` : `feat/${item}`;
}

/** The worktree path convention: one directory per branch, `/` flattened to `-`. */
export function worktreePathFor(worktreeRoot: string, branch: string): string {
  return resolve(worktreeRoot, branch.replace(/\//g, "-"));
}

// ── Deps: everything the passes touch, injectable ──────────────────────────

export interface StageRun {
  item: number;
  stage: StageName;
  agent: string;
  cwd: string;
  task: string;
  timeoutMs: number;
  /** Called the moment the child exists, so the record carries its pid before we wait. */
  onSpawn?: (pid: number, pidStart: string | null) => void;
}

export interface StageOutcome {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface Deps {
  now(): number;
  exec: Exec;
  live: Liveness;
  spawnStage(run: StageRun): Promise<StageOutcome>;
  /** Kill a whole process group, the stage's grandchildren included. */
  killGroup(pid: number): void;
  log(msg: string): void;
  /** The page on a block. A failed page is logged, never fatal, never blocks the block. */
  page(title: string, body: string): void;
}

export interface Ctx {
  root: string;
  jobsDir: string;
  worktreeRoot: string;
  dryRun: boolean;
  deps: Deps;
}

export function readPidStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parens, so fields are counted from the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

const liveLiveness: Liveness = { startTime: readPidStart };

/** A `pi` child leaves grandchildren behind it, so the whole group goes, never the pid alone. */
function killGroupDefault(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never its own group leader: nothing left to kill.
  }
}

/** Cheap and mechanical: the wrapper relays, the child does the work. */
const WRAPPER_MODEL = "deepseek/deepseek-flash";

export function piBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.FACTORY_PI_BIN ?? env.PI_BIN;
  if (configured && configured.trim()) return configured.trim();
  const res = defaultExec("sh", ["-c", "command -v pi"]);
  if (res.code === 0 && res.stdout.trim()) return res.stdout.trim();
  const fallback = resolve(homedir(), ".local/bin/pi");
  return existsSync(fallback) ? fallback : null;
}

/**
 * The prompt for the one-process wrapper. `async: false` matters: with async children the
 * wrapper would exit immediately and the drainer would record a stage that never ran.
 */
export function wrapperPrompt(agent: string, task: string): string {
  return [
    "Spawn exactly one child agent, then stop.",
    "",
    `Call subagent({ agent: ${JSON.stringify(agent)}, context: "fresh", async: false, task: <the task text between the markers below> }) exactly once, and wait for it.`,
    "Do not do the work yourself. Do not read files, run commands or call any other tool.",
    "When the child returns, print its final message verbatim as your entire output, then stop.",
    "",
    "--- TASK START ---",
    task,
    "--- TASK END ---",
  ].join("\n");
}

const defaultSpawnStage = (env: NodeJS.ProcessEnv = process.env) => async (run: StageRun): Promise<StageOutcome> => {
  const pi = piBinary(env);
  if (!pi) throw new Error("pi is not on PATH and no binary at $HOME/.local/bin/pi; set FACTORY_PI_BIN");
  const child = spawn(
    pi,
    ["-p", "--approve", "--tools", "subagent", "--model", WRAPPER_MODEL, "--thinking", "off", wrapperPrompt(run.agent, run.task)],
    {
      cwd: run.cwd,
      // Its own process group, so a kill takes the grandchildren (bash runs, subagents) too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const pid = child.pid ?? 0;
  if (pid) run.onSpawn?.(pid, readPidStart(pid));

  const killGroup = (): void => {
    if (pid) killGroupDefault(pid);
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, run.timeoutMs);

  const code = await new Promise<number | null>((done) => {
    child.on("error", () => done(null));
    child.on("close", (exit) => done(exit));
  });
  clearTimeout(timer);
  // The same group-kill after a normal wait, so nothing outlives its stage.
  killGroup();
  return { code, timedOut, stdout, stderr };
};

const defaultDeps = (env: NodeJS.ProcessEnv = process.env): Deps => ({
  now: () => Date.now(),
  exec: defaultExec,
  live: liveLiveness,
  spawnStage: defaultSpawnStage(env),
  killGroup: killGroupDefault,
  log: (msg) => process.stdout.write(`${msg}\n`),
  page: (title, body) => {
    const res = defaultExec("npx", ["tsx", resolve(SCRIPT_ROOT, "scripts/send-dm.ts"), "--title", title, body], {
      cwd: SCRIPT_ROOT,
      timeoutMs: 60_000,
    });
    if (res.code !== 0) process.stdout.write(`[factory-jobs] DM failed (logged, not fatal): ${res.stderr.trim()}\n`);
  },
});

// ── The board, through gh ─────────────────────────────────────────────────

export interface BoardItem {
  itemId: string;
  number: number;
  title: string;
  url: string;
  status: string;
  priority: string | null;
  milestone: string | null;
  labels: string[];
}

interface ProjectConfig {
  projectId: string;
  projectNumber: number;
  owner: string;
  repo: string;
  statusFieldId: string;
  statusOptions: Record<string, string>;
}

const PRIORITY_RANK: Record<string, number> = {
  "P0 - urgent": 0,
  "P1 - high": 1,
  "P2 - normal": 2,
  "P3 - low": 3,
};

/** Standing-approval classes: the only work that runs without per-item approval. */
export const AUTO_LABELS = ["auto:docs", "auto:changelog", "auto:tests"] as const;

export function readProjectConfig(root: string): ProjectConfig {
  const path = resolve(root, ".pi/factory/project.json");
  let raw: {
    projectId: string;
    projectNumber: number;
    owner: string;
    repo: string;
    fields: { Status: { id: string; options: Record<string, string> } };
  };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    projectId: raw.projectId,
    projectNumber: raw.projectNumber,
    owner: raw.owner,
    repo: raw.repo,
    statusFieldId: raw.fields.Status.id,
    statusOptions: raw.fields.Status.options,
  };
}

function gh(ctx: Ctx, args: string[], input?: string): string {
  const res = ctx.deps.exec("gh", args, { cwd: ctx.root, input, timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

function ghJson<T>(ctx: Ctx, args: string[]): T {
  const raw = gh(ctx, args);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function fetchBoard(ctx: Ctx, config: ProjectConfig): BoardItem[] {
  const raw = ghJson<{
    items: {
      id?: string;
      status?: string;
      priority?: string | null;
      labels?: string[];
      milestone?: { title?: string };
      content?: { number?: number; title?: string; url?: string };
    }[];
  }>(ctx, [
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
    if (number === undefined || !entry.id) continue;
    items.push({
      itemId: entry.id,
      number,
      title: entry.content?.title ?? `#${number}`,
      url: entry.content?.url ?? `https://github.com/${config.repo}/issues/${number}`,
      status: entry.status ?? "",
      priority: entry.priority ?? null,
      milestone: entry.milestone?.title ?? null,
      labels: entry.labels ?? [],
    });
  }
  return items;
}

export function setStatus(ctx: Ctx, config: ProjectConfig, item: BoardItem, status: string): void {
  const option = config.statusOptions[status];
  if (!option) throw new Error(`No board option named "${status}" in .pi/factory/project.json`);
  if (ctx.dryRun) return void ctx.deps.log(`[dry-run] board: #${item.number} → ${status}`);
  gh(ctx, [
    "project",
    "item-edit",
    "--id",
    item.itemId,
    "--project-id",
    config.projectId,
    "--field-id",
    config.statusFieldId,
    "--single-select-option-id",
    option,
  ]);
}

export function commentOn(ctx: Ctx, config: ProjectConfig, number: number, body: string): void {
  if (ctx.dryRun) return void ctx.deps.log(`[dry-run] comment on #${number}: ${body.split("\n")[0]}`);
  gh(ctx, ["issue", "comment", String(number), "--repo", config.repo, "--body-file", "-"], body);
}

/** Comments on an issue, oldest first. Only the adoption path needs these. */
export function fetchComments(ctx: Ctx, config: ProjectConfig, number: number): { author: string; body: string }[] {
  const raw = ghJson<{ comments: { author?: { login?: string }; body?: string }[] }>(ctx, [
    "issue",
    "view",
    String(number),
    "--repo",
    config.repo,
    "--json",
    "comments",
  ]);
  return (raw.comments ?? []).map((c) => ({ author: c.author?.login ?? "unknown", body: c.body ?? "" }));
}

// ── Picking work, and adopting it ─────────────────────────────────────────

export function hasJobRecord(item: number, jobs: JobRecord[]): boolean {
  return jobs.some((job) => job.item === item);
}

/** `Approved`, or an `auto:*` item still upstream of execution. `Blocked`/`Done` never. */
export function isGated(item: BoardItem): boolean {
  if (item.status === "Approved") return true;
  const auto = item.labels.some((label) => (AUTO_LABELS as readonly string[]).includes(label));
  return auto && (item.status === "Inbox" || item.status === "Triaged");
}

const PICKABLE_STATUSES = new Set(["Approved", "Inbox", "Triaged"]);

/** Highest priority then oldest, one item per job. */
export function pickCandidate(items: BoardItem[], jobs: JobRecord[]): BoardItem | null {
  const eligible = items.filter(
    (item) => PICKABLE_STATUSES.has(item.status) && isGated(item) && !hasJobRecord(item.number, jobs),
  );
  eligible.sort((a, b) => {
    const rank = (PRIORITY_RANK[a.priority ?? ""] ?? 9) - (PRIORITY_RANK[b.priority ?? ""] ?? 9);
    return rank !== 0 ? rank : a.number - b.number;
  });
  return eligible[0] ?? null;
}

export interface AdoptionProposal {
  item: BoardItem;
  branch: string;
  /** `review` when the branch already carries commits ahead of `dev`, else `build`. */
  stage: StageName;
  commit: string | null;
}

const CLAIM_COMMENT = /factory:\s*claimed(?:\s*\(branch\s+([^\s)]+)\))?/i;

/** A branch claimed by an older run is named in the claim comment; the glob is the fallback. */
export function claimedBranch(comments: { body: string }[], number: number, branches: string[]): string | null {
  for (const comment of comments) {
    const match = CLAIM_COMMENT.exec(comment.body);
    const branch = match?.[1];
    if (branch) {
      // `git branch -a` reports remotes as `origin/<branch>`.
      const local = branches.find((b) => b === branch || b === `origin/${branch}` || b.endsWith(`/${branch}`));
      if (local) return local.replace(/^origin\//, "");
    }
  }
  return branches.find((b) => /(^|\/)\d+-/.test(b) && b.includes(`/${number}-`))?.replace(/^origin\//, "") ?? null;
}

/**
 * An orphan is an `In Progress` item with no job record and evidence a run got there first:
 * a factory claim comment naming the branch, a branch whose name carries the item number and
 * a slug, or a worktree still checked out at it. Anything else `In Progress` is left for the
 * owner or the sweeper, so an item a human set by hand is never silently taken over.
 */
export function findAdoptable(
  items: BoardItem[],
  jobs: JobRecord[],
  ctx: { branches: string[]; commentsFor(number: number): { body: string }[]; hasCommits(branch: string): boolean; headOf(branch: string): string | null },
): AdoptionProposal | null {
  const orphans = items
    .filter((item) => item.status === "In Progress" && !hasJobRecord(item.number, jobs))
    .sort((a, b) => a.number - b.number);
  for (const item of orphans) {
    const branch = claimedBranch(ctx.commentsFor(item.number), item.number, ctx.branches);
    if (!branch) continue;
    const hasCommits = ctx.hasCommits(branch);
    return { item, branch, stage: hasCommits ? "review" : "build", commit: hasCommits ? ctx.headOf(branch) : null };
  }
  return null;
}

// ── Records on disk, and the drain lock ───────────────────────────────────

export function jobPath(jobsDir: string, item: number): string {
  return resolve(jobsDir, `${item}.json`);
}

export function archivePath(jobsDir: string, item: number): string {
  return resolve(jobsDir, "archive", `${item}.json`);
}

export function loadJobs(jobsDir: string): JobRecord[] {
  if (!existsSync(jobsDir)) return [];
  const jobs: JobRecord[] = [];
  for (const entry of readdirSync(jobsDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      jobs.push(JSON.parse(readFileSync(resolve(jobsDir, entry), "utf8")) as JobRecord);
    } catch (err) {
      process.stdout.write(`[factory-jobs] ignoring unreadable record ${entry}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return jobs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.item - b.item);
}

/** Temp file plus rename, so a killed drainer never leaves half a record behind. */
export function saveJob(ctx: Ctx, job: JobRecord): void {
  job.updatedAt = new Date(ctx.deps.now()).toISOString();
  if (ctx.dryRun) return void ctx.deps.log(`[dry-run] record #${job.item}: ${job.stage}/${job.stageState}`);
  mkdirSync(ctx.jobsDir, { recursive: true });
  const path = jobPath(ctx.jobsDir, job.item);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(tmp, path);
}

export function archiveJob(ctx: Ctx, job: JobRecord): void {
  if (ctx.dryRun) return void ctx.deps.log(`[dry-run] archive #${job.item}`);
  const dir = resolve(ctx.jobsDir, "archive");
  mkdirSync(dir, { recursive: true });
  writeFileSync(archivePath(ctx.jobsDir, job.item), `${JSON.stringify(job, null, 2)}\n`);
  rmSync(jobPath(ctx.jobsDir, job.item), { force: true });
}

export function artifactPath(ctx: Ctx, item: number, stage: StageName): string {
  return resolve(ctx.jobsDir, "artifacts", String(item), `${stage}.md`);
}

function lockPath(ctx: Ctx): string {
  return resolve(ctx.jobsDir, ".drain.lock");
}

export interface Lock {
  release(): void;
}

/**
 * Non-blocking, and held for the whole command. A holder that is provably alive means
 * another drainer is mid-stage: fail soft and report rather than waiting, because worst
 * case a start colliding with a by-hand drain slips a day. A holder that is gone is a
 * crashed drainer, and its lock is stale.
 */
export function acquireLock(ctx: Ctx): Lock | null {
  if (ctx.dryRun) return { release: () => {} };
  mkdirSync(ctx.jobsDir, { recursive: true });
  const path = lockPath(ctx);
  const mine: Claim = { pid: process.pid, pidStart: readPidStart(process.pid) };
  const attempt = (): boolean => {
    try {
      writeFileSync(path, `${JSON.stringify(mine)}\n`, { flag: "wx", mode: 0o644 });
      return true;
    } catch {
      return false;
    }
  };
  if (!attempt()) {
    let holder: Claim | null = null;
    try {
      holder = JSON.parse(readFileSync(path, "utf8")) as Claim;
    } catch {
      holder = null;
    }
    if (holder && probeClaim(holder, ctx.deps.live) === "live") {
      ctx.deps.log(`[factory-jobs] drain lock held by pid ${holder.pid}; nothing to do`);
      return null;
    }
    ctx.deps.log("[factory-jobs] taking over a stale drain lock (its holder is gone)");
    rmSync(path, { force: true });
    if (!attempt()) return null;
  }
  return {
    release: () => rmSync(path, { force: true }),
  };
}

// ── Code stages ───────────────────────────────────────────────────────────

export interface Command {
  cmd: string;
  args: string[];
  input?: string;
}

function git(ctx: Ctx, args: string[], cwd = ctx.root, timeoutMs = 60_000): ExecResult {
  return ctx.deps.exec("git", args, { cwd, timeoutMs });
}

function gitOrThrow(ctx: Ctx, args: string[], cwd = ctx.root, timeoutMs = 60_000): string {
  const res = git(ctx, args, cwd, timeoutMs);
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

function commitsAhead(ctx: Ctx, branch: string): number {
  const res = git(ctx, ["rev-list", "--count", `${UPSTREAM_REF}..${branch}`]);
  return res.code === 0 ? Number.parseInt(res.stdout.trim() || "0", 10) : 0;
}

/** The PR body is generated, not composed: the commits are what changed, the issue is why. */
export function deliverBody(ctx: Ctx, job: JobRecord): string {
  const log = git(ctx, ["log", "--no-merges", "--pretty=format:- %s", `${UPSTREAM_REF}..${job.branch}`], job.worktree);
  const changed = log.code === 0 && log.stdout.trim() ? log.stdout.trim() : "- (no commit subjects found)";
  return [
    `Closes #${job.item}`,
    "",
    "Opened by the Dark Factory job ledger (`scripts/factory-jobs.ts`) — no agent ran this step.",
    "",
    "## What changed",
    "",
    changed,
    "",
    "## Why",
    "",
    `${job.title} (board item #${job.item}).`,
    "",
    "## How it was verified",
    "",
    `The \`build\` and \`fix\` stages ran the repo's full suite and typecheck before committing; the reports are in the job's ledger record (\`.pi/factory/jobs/${job.item}.json\`).`,
  ].join("\n");
}

/** Pure so the argv can be asserted without a repo: push, then the PR to `dev`. */
export function deliverCommands(ctx: Ctx, job: JobRecord): Command[] {
  return [
    { cmd: "git", args: ["push", "-u", "origin", job.branch] },
    {
      cmd: "gh",
      args: ["pr", "create", "--base", job.baseRef, "--head", job.branch, "--title", job.title, "--body-file", "-"],
      input: deliverBody(ctx, job),
    },
  ];
}

function runCommand(ctx: Ctx, command: Command, cwd = ctx.root): string {
  if (ctx.dryRun) {
    ctx.deps.log(`[dry-run] ${command.cmd} ${command.args.join(" ")}`);
    return "";
  }
  const res = ctx.deps.exec(command.cmd, command.args, { cwd, input: command.input, timeoutMs: 5 * MIN });
  if (res.code !== 0) throw new Error(`${command.cmd} ${command.args.slice(0, 2).join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

// ── Stage tasks ───────────────────────────────────────────────────────────

export function stageTask(ctx: Ctx, job: JobRecord, stage: StageName, artifact: string): string {
  const head = [
    `FACTORY LEDGER STAGE: ${stage}`,
    "",
    `You are running the **${stage}** stage of a Dark Factory job, not an interactive task.`,
    "",
    `- Board item: #${job.item} — ${job.title}`,
    `- Worktree (your cwd): ${job.worktree}`,
    `- Branch: ${job.branch} (base \`${job.baseRef}\`)`,
    `- Your report file: ${artifact}`,
    "",
  ];
  if (stage === "build") {
    head.push(
      `Implement the item's acceptance criteria (read them with \`gh issue view ${job.item}\`).`,
      `Read \`.pi/factory/memory/\` first: gate, board and repo facts save rediscovering them.`,
      `Stay inside the item's scope. Keep the changelog current per the \`changelog\` skill.`,
      `Run the full test suite and typecheck, and only commit when both are green.`,
      `Commit your work on \`${job.branch}\` with a conventional-commit subject naming #${job.item}.`,
      `Then write your report to ${artifact}: files changed, verification counts, anything you could not do.`,
    );
  } else if (stage === "review") {
    head.push(
      `Review the commits on \`${job.branch}\` (see \`git log --oneline ${job.baseRef}..${job.branch}\` and \`git show\`).`,
      `You are read-only: do not modify any tracked file in the worktree. The drainer fails the stage if the worktree is dirty.`,
      `Write your findings to ${artifact}. Its **first line must be** either \`VERDICT: clean\` or \`VERDICT: findings\`.`,
      `Rank findings most severe first, each with \`file:line\` and a concrete failing scenario.`,
    );
  } else if (stage === "fix") {
    head.push(
      `Read the review findings at ${job.artifacts.review ?? artifactPath(ctx, job.item, "review")} and fix exactly what they report.`,
      `Do not reopen the review or add improvements of your own.`,
      `Run the full test suite and typecheck, and commit on \`${job.branch}\` when both are green.`,
      `Write your report to ${artifact}. Its first line is \`VERDICT: ok\`, or \`VERDICT: nochange\` if a finding genuinely needs no code change.`,
      `If you commit nothing and the findings did need work, the stage is a failure.`,
    );
  }
  return head.join("\n");
}

function porcelain(ctx: Ctx, worktree: string): string {
  return git(ctx, ["status", "--porcelain"], worktree).stdout.trim();
}

function readArtifact(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ── Passes ────────────────────────────────────────────────────────────────

function fail(job: JobRecord, stage: StageName, startedAt: number, endedAt: number, result: StageResult, exit: number | null): void {
  job.history.push({
    stage,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    result,
    exit,
    spentMs: endedAt - startedAt,
  });
  // Charged even when the drainer was killed: a failed attempt cannot hide its cost.
  job.spentMs += Math.max(0, endedAt - startedAt);
  job.attempts[stage] = (job.attempts[stage] ?? 0) + 1;
  job.stageState = "ready";
  job.claim = null;
  job.stageStartedAt = undefined;
}

function succeed(job: JobRecord, stage: StageName, startedAt: number, endedAt: number, result: StageResult, exit: number | null): void {
  job.history.push({
    stage,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    result,
    exit,
    spentMs: endedAt - startedAt,
  });
  job.spentMs += Math.max(0, endedAt - startedAt);
  job.claim = null;
  job.stageState = "ready";
  job.stageStartedAt = undefined;
  const next = nextStage(stage);
  if (next) job.stage = next;
}

function blockJob(ctx: Ctx, config: ProjectConfig, job: JobRecord, item: BoardItem | undefined, reason: string): void {
  job.stageState = "blocked";
  job.claim = null;
  const body = blockBody(job, reason);
  ctx.deps.log(`[factory-jobs] blocked #${job.item}: ${reason}`);
  // The page goes first and is the only thing that may fail the block: the DM is the single
  // channel that reaches the owner off-board, and a gh hiccup is exactly the weather in which
  // a block happens. Board writes are best effort, and `pagedAt` records that the page went
  // out, so a tick that dies before it pages is retried instead of skipped for ever.
  if (!ctx.dryRun) page(ctx, job, reason, body);
  saveJob(ctx, job);
  bestEffort(ctx, () => {
    if (item) setStatus(ctx, config, item, "Blocked");
  }, "board status to Blocked");
  bestEffort(ctx, () => commentOn(ctx, config, job.item, body), "block comment");
}

function blockBody(job: JobRecord, reason: string): string {
  return [
    `**factory: blocked at \`${job.stage}\`.** ${reason}.`,
    "",
    `- item: #${job.item} — ${job.title}`,
    `- branch: \`${job.branch}\` (kept)`,
    `- worktree: \`${job.worktree}\` (kept)`,
    `- spent: ${Math.round(job.spentMs / MIN)} of ${Math.round(JOB_CAP_MS / MIN)} minutes`,
    `- attempts: ${JSON.stringify(job.attempts)}`,
    "",
    `Unblock with \`npx tsx scripts/factory-jobs.ts retry ${job.item}\`, which refreshes the budget and clears the attempts.`,
  ].join("\n");
}

/** A board write that must never lose the page or the record. */
function bestEffort(ctx: Ctx, run: () => void, what: string): void {
  try {
    run();
  } catch (err) {
    ctx.deps.log(`[factory-jobs] ${what} failed (logged, not fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function page(ctx: Ctx, job: JobRecord, reason: string, body: string): void {
  try {
    ctx.deps.page(`Dark Factory: job #${job.item} blocked`, `${reason}.\n\n${job.title}\n\n${body}`);
    job.pagedAt = new Date(ctx.deps.now()).toISOString();
  } catch (err) {
    ctx.deps.log(`[factory-jobs] page failed (logged, still retried next tick): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function boardItem(ctx: Ctx, config: ProjectConfig, job: JobRecord): BoardItem | undefined {
  return fetchBoard(ctx, config).find((item) => item.number === job.item);
}

function resumeItem(ctx: Ctx, config: ProjectConfig, job: JobRecord): void {
  const item = boardItem(ctx, config, job);
  if (item) setStatus(ctx, config, item, "In Progress");
}

async function runModelStage(ctx: Ctx, job: JobRecord, stage: StageName): Promise<{ ok: boolean; result: StageResult; exit: number | null; startedAt: number; endedAt: number }> {
  const spec = STAGES[stage];
  const artifact = artifactPath(ctx, job.item, stage);
  const startedAt = ctx.deps.now();
  job.stageState = "running";
  job.claim = null;
  job.stageStartedAt = new Date(startedAt).toISOString();
  saveJob(ctx, job);

  if (!ctx.dryRun) mkdirSync(dirname(artifact), { recursive: true });
  const branchBefore = git(ctx, ["rev-parse", job.branch], job.worktree).stdout.trim();
  // Snapshot the dirt before the child runs: a build that drops ungitignored artifacts must
  // not doom a review that changed nothing, and the review must still be held to its own edits.
  const dirtyBefore = porcelain(ctx, job.worktree);
  const outcome = await ctx.deps.spawnStage({
    item: job.item,
    stage,
    agent: spec.agent!,
    cwd: job.worktree,
    task: stageTask(ctx, job, stage, artifact),
    timeoutMs: attemptTimeoutMs(job),
    onSpawn: (pid, pidStart) => {
      job.claim = { pid, pidStart };
      saveJob(ctx, job);
    },
  });
  const endedAt = ctx.deps.now();
  const text = readArtifact(artifact);

  if (outcome.timedOut) return { ok: false, result: "timeout", exit: outcome.code, startedAt, endedAt };
  if (outcome.code !== 0) return { ok: false, result: "failed", exit: outcome.code, startedAt, endedAt };
  if (!text.trim()) {
    ctx.deps.log(`[factory-jobs] ${stage} stage wrote no report to ${artifact}`);
    return { ok: false, result: "failed", exit: outcome.code, startedAt, endedAt };
  }
  // The branch, not bare HEAD: a stage that commits somewhere else has not moved the job on,
  // and the failure belongs at this stage rather than at an empty PR later.
  const branchAfter = git(ctx, ["rev-parse", job.branch], job.worktree).stdout.trim();
  job.artifacts[stage] = artifact;

  if (stage === "build" || stage === "fix") {
    // Only the fixer may accept a finding without a commit: a build that claims `nochange`
    // has implemented nothing, and its stage fails on the branch check below.
    if (stage === "fix" && parseVerdict(text) === "nochange") {
      return { ok: true, result: "nochange", exit: outcome.code, startedAt, endedAt };
    }
    if (branchAfter === branchBefore) {
      ctx.deps.log(`[factory-jobs] ${stage} stage committed nothing on ${job.branch}`);
      return { ok: false, result: "failed", exit: outcome.code, startedAt, endedAt };
    }
  }
  const dirtyAfter = porcelain(ctx, job.worktree);
  if (stage === "review") {
    // Read-only is code-enforced: the reviewer may write its report, nothing in the worktree,
    // and it may not commit either — a commit would otherwise be delivered as reviewed work.
    if (dirtyBefore) {
      ctx.deps.log(`[factory-jobs] the worktree was already dirty before the review ran (not the reviewer's doing):\n${dirtyBefore}`);
    }
    if (dirtyAfter !== dirtyBefore || branchAfter !== branchBefore) {
      ctx.deps.log(
        `[factory-jobs] review stage is not read-only: ${dirtyAfter !== dirtyBefore ? "it changed the worktree" : ""}` +
          `${branchAfter !== branchBefore ? ` ${job.branch} moved from ${branchBefore.slice(0, 7)} to ${branchAfter.slice(0, 7)}` : ""}`,
      );
      return { ok: false, result: "failed", exit: outcome.code, startedAt, endedAt };
    }
  } else if (dirtyAfter) {
    // Not fatal — the leftovers are uncommitted, so they never reach the PR — but the next
    // stage and a human reading the worktree both want to know.
    ctx.deps.log(`[factory-jobs] ${stage} stage left uncommitted files behind:\n${dirtyAfter}`);
  }
  return { ok: true, result: "ok", exit: outcome.code, startedAt, endedAt };
}

async function runDeliver(ctx: Ctx, config: ProjectConfig, job: JobRecord): Promise<void> {
  const startedAt = ctx.deps.now();
  // A retry after a partial success must not create a second PR for the branch: a `gh` failure
  // between `pr create` and the record write is a seconds-wide window, and "a pull request for
  // branch ... already exists" would wedge the job for ever on a branch that is already fine.
  const existing = existingPr(ctx, config, job);
  let url = existing?.url ?? "";
  if (existing) {
    ctx.deps.log(`[factory-jobs] #${job.item}: reusing the open PR #${existing.number} for ${job.branch}`);
  } else {
    const [push, pr] = deliverCommands(ctx, job);
    runCommand(ctx, push, job.worktree);
    const created = runCommand(ctx, pr);
    url = created.trim().split("\n").pop() ?? "";
    const number = Number.parseInt(url.split("/").pop() ?? "", 10);
    if (!ctx.dryRun && !Number.isFinite(number)) {
      throw new Error(`could not read a PR number from gh output: ${created.trim()}`);
    }
    job.pr = Number.isFinite(number) ? number : null;
  }
  // Past this point the PR exists, so nothing here may fail the stage: the board and the
  // comment are best effort, exactly like the block's.
  bestEffort(
    ctx,
    () => {
      const item = boardItem(ctx, config, job);
      if (item) setStatus(ctx, config, item, "In Review");
    },
    "board status to In Review",
  );
  bestEffort(
    ctx,
    () =>
      commentOn(
        ctx,
        config,
        job.item,
        `factory: PR opened for review — ${url || "(dry run)"}\n\nNo agent merged it; merging is the owner's step. The ledger will move this item to \`Done\` and close the issue once it is merged.`,
      ),
    "PR-link comment",
  );
  succeed(job, "deliver", startedAt, ctx.deps.now(), "ok", null);
  ctx.deps.log(`[factory-jobs] #${job.item}: PR opened for review — ${url || "(dry run)"}`);
}

/** The open PR for this job's branch, if a previous attempt already opened one. */
function existingPr(ctx: Ctx, config: ProjectConfig, job: JobRecord): { number: number; url: string } | null {
  if (ctx.dryRun) return null;
  const raw = gh(ctx, [
    "pr",
    "list",
    "--repo",
    config.repo,
    "--head",
    job.branch,
    "--state",
    "open",
    "--json",
    "number,url",
  ]);
  let prs: { number: number; url: string }[];
  try {
    prs = JSON.parse(raw || "[]") as { number: number; url: string }[];
  } catch {
    throw new Error(`gh pr list returned unparseable JSON for ${job.branch}`);
  }
  const pr = prs[0];
  if (!pr) return null;
  job.pr = pr.number;
  return pr;
}

async function runReconcile(ctx: Ctx, config: ProjectConfig, job: JobRecord): Promise<void> {
  const startedAt = ctx.deps.now();
  if (!job.pr) throw new Error("job carries no PR number to reconcile");
  // Read even in a dry run: reading is neither spawning nor writing, and a dry run that
  // could only ever see an open PR would tell the operator nothing.
  const raw = gh(ctx, ["pr", "view", String(job.pr), "--repo", config.repo, "--json", "state,mergedAt"]);
  let pr: { state: string; mergedAt: string | null };
  try {
    pr = JSON.parse(raw) as { state: string; mergedAt: string | null };
  } catch {
    throw new Error(`gh pr view returned unparseable JSON for PR #${job.pr}`);
  }
  if (pr.state === "OPEN") {
    // No history entry per pass: a week of ticks would swamp the record, and waiting
    // costs nothing, so there is nothing to charge. `waitingSince` is the durable fact.
    job.stageState = "waiting";
    job.waitingSince = job.waitingSince ?? new Date(ctx.deps.now()).toISOString();
    job.claim = null;
    job.stageStartedAt = undefined;
    ctx.deps.log(`[factory-jobs] PR #${job.pr} is still open; #${job.item} waits at no cost`);
    return;
  }
  if (pr.state === "CLOSED" || !pr.mergedAt) {
    job.stageState = "ready";
    throw new Error(`PR #${job.pr} was closed without merging`);
  }
  const item = boardItem(ctx, config, job);
  if (item) setStatus(ctx, config, item, "Done");
  if (!ctx.dryRun) {
    gh(ctx, [
      "issue",
      "close",
      String(job.item),
      "--repo",
      config.repo,
      "--comment",
      `Merged as #${job.pr}. Status \`Done\` set by the job ledger.`,
    ]);
  } else {
    ctx.deps.log(`[dry-run] close #${job.item}`);
  }
  job.waitingSince = undefined;
  succeed(job, "reconcile", startedAt, ctx.deps.now(), "ok", null);
}

function runDone(ctx: Ctx, job: JobRecord): void {
  const startedAt = ctx.deps.now();
  // A dry run decides and reports; it never removes a worktree or kills a process.
  if (ctx.dryRun) {
    ctx.deps.log(`[dry-run] git worktree remove --force ${job.worktree}`);
  } else {
    const res = git(ctx, ["worktree", "remove", "--force", job.worktree]);
    if (res.code !== 0) throw new Error(`git worktree remove failed: ${res.stderr.trim()}`);
  }
  succeed(job, "done", startedAt, ctx.deps.now(), "ok", null);
  // The branch outlives the job: `done` means merged, and those commits are the record.
  archiveJob(ctx, job);
  ctx.deps.log(`[factory-jobs] job #${job.item} done; branch ${job.branch} kept`);
}

export interface DrainOutcome {
  action: "locked" | "idle" | "reaped" | "requeued" | "blocked" | "ran" | "finished";
  item?: number;
  detail?: string;
}

/**
 * The tick's one thing. `start` and `retry` take the same lock, so a start colliding with a
 * by-hand drain reports instead of waiting: worst case it slips a day.
 */
export async function drainOnce(ctx: Ctx): Promise<DrainOutcome> {
  const lock = acquireLock(ctx);
  if (!lock) return { action: "locked" };
  try {
    const all = loadJobs(ctx.jobsDir);
    const jobs = all.filter((job) => job.schemaVersion === SCHEMA_VERSION);
    for (const job of all) {
      if (job.schemaVersion !== SCHEMA_VERSION) {
        ctx.deps.log(
          `[factory-jobs] ignoring #${job.item}: schemaVersion ${job.schemaVersion}, this build reads ${SCHEMA_VERSION}`,
        );
      }
    }
    if (!jobs.length) return { action: "idle" };
    const config = readProjectConfig(ctx.root);
    // A job waiting on the owner costs nothing, so its one PR check per tick is not the
    // tick's decisive action: it must never starve the jobs that still have work in them.
    for (const job of jobs) {
      if (job.stageState !== "waiting") continue;
      const settled = await checkWaiting(ctx, config, job);
      if (settled) return settled;
    }
    for (const job of jobs) {
      const action = decide(job, ctx.deps.live);
      if (action.kind === "skip") continue;
      const attemptStart = Date.parse(job.stageStartedAt ?? job.updatedAt);
      if (action.kind === "page") {
        // A block whose own tick died before paging: retry the page, never the stage.
        page(ctx, job, action.reason, blockBody(job, action.reason));
        saveJob(ctx, job);
        return { action: "blocked", item: job.item, detail: action.reason };
      }
      if (action.kind === "reap") {
        const pid = job.claim?.pid;
        // A live pid with a matching start time is provably ours; a recycled number never
        // reaches here (decide() only reaps on an exact match).
        if (pid && !ctx.dryRun) ctx.deps.killGroup(pid);
        fail(job, job.stage, attemptStart, ctx.deps.now(), "reaped", null);
        saveJob(ctx, job);
        ctx.deps.log(`[factory-jobs] reaped #${job.item} (${action.reason}); requeued ${job.stage}`);
        return { action: "reaped", item: job.item, detail: action.reason };
      }
      if (action.kind === "requeue") {
        fail(job, job.stage, attemptStart, ctx.deps.now(), "failed", null);
        saveJob(ctx, job);
        ctx.deps.log(`[factory-jobs] requeued #${job.item} (${action.reason}); ${job.stage} attempt ${job.attempts[job.stage] ?? 0}`);
        return { action: "requeued", item: job.item, detail: action.reason };
      }
      if (action.kind === "block") {
        blockJob(ctx, config, job, boardItem(ctx, config, job), action.reason);
        return { action: "blocked", item: job.item, detail: action.reason };
      }
      return await runOneStage(ctx, config, job);
    }
    return { action: "idle" };
  } finally {
    lock.release();
  }
}

/** A waiting job's cheap re-check. Returns an outcome only when the PR has settled. */
async function checkWaiting(ctx: Ctx, config: ProjectConfig, job: JobRecord): Promise<DrainOutcome | null> {
  try {
    await runReconcile(ctx, config, job);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/closed without merging/.test(reason)) {
      job.stageState = "ready";
      blockJob(ctx, config, job, boardItem(ctx, config, job), reason);
      return { action: "blocked", item: job.item, detail: reason };
    }
    // A transient gh failure is not a failed attempt: the job is waiting on a human, and
    // the next tick re-checks for free.
    ctx.deps.log(`[factory-jobs] reconcile check on #${job.item} failed: ${reason}`);
    return null;
  }
  if (job.stageState === "waiting") {
    saveJob(ctx, job);
    return null;
  }
  // Merged: `done` follows in the same code path, exactly as it does on the fresh path. The
  // waiting path is the normal one (a human merges days later), so a tick that stopped here
  // would park the worktree and the record for ever.
  saveJob(ctx, job);
  finishJob(ctx, job);
  return { action: "finished", item: job.item, detail: `PR #${job.pr} merged` };
}

/** Worktree removed, record archived, branch kept — the last thing a job ever does. */
function finishJob(ctx: Ctx, job: JobRecord): void {
  runDone(ctx, job);
}

async function runOneStage(ctx: Ctx, config: ProjectConfig, job: JobRecord): Promise<DrainOutcome> {
  const stage = job.stage;
  if (STAGES[stage].kind === "code") {
    const startedAt = ctx.deps.now();
    job.stageStartedAt = new Date(startedAt).toISOString();
    try {
      if (stage === "deliver") {
        await runDeliver(ctx, config, job);
        saveJob(ctx, job);
        return { action: "ran", item: job.item, detail: "deliver" };
      }
      if (stage === "reconcile") {
        await runReconcile(ctx, config, job);
        if (job.stageState === "waiting") {
          saveJob(ctx, job);
          return { action: "idle", item: job.item, detail: "reconcile waiting" };
        }
        saveJob(ctx, job);
        // `done` follows a merge immediately: worktree removed, record archived.
        finishJob(ctx, job);
        return { action: "finished", item: job.item, detail: "merged" };
      }
      finishJob(ctx, job);
      return { action: "finished", item: job.item, detail: "done" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // `job.stage`, not the cached local: `runReconcile` advances to `done` before this
      // throws, and a cleanup failure must not be booked against the stage that succeeded.
      fail(job, job.stage, startedAt, ctx.deps.now(), "failed", null);
      if (job.stage === "reconcile" && /closed without merging/.test(reason)) {
        job.stageState = "ready";
        blockJob(ctx, config, job, boardItem(ctx, config, job), reason);
        return { action: "blocked", item: job.item, detail: reason };
      }
      saveJob(ctx, job);
      ctx.deps.log(`[factory-jobs] ${job.stage} failed on #${job.item}: ${reason}`);
      return { action: "ran", item: job.item, detail: `${job.stage} failed` };
    }
  }

  if (ctx.dryRun) {
    ctx.deps.log(
      `[dry-run] #${job.item} ${stage}: would spawn ${STAGES[stage].agent} for ${Math.round(attemptTimeoutMs(job) / MIN)} min in ${job.worktree}`,
    );
    return { action: "ran", item: job.item, detail: `dry-run: ${stage}` };
  }

  ctx.deps.log(
    `[factory-jobs] #${job.item} ${stage}: spawning ${STAGES[stage].agent} (${Math.round(attemptTimeoutMs(job) / MIN)} min budget)`,
  );
  const run = await runModelStage(ctx, job, stage);
  if (!run.ok) {
    fail(job, stage, run.startedAt, run.endedAt, run.result, run.exit);
    saveJob(ctx, job);
    ctx.deps.log(
      `[factory-jobs] #${job.item} ${stage} ${run.result}; requeued (attempt ${job.attempts[stage] ?? 0}/${MAX_ATTEMPTS}), ` +
        `${Math.round(job.spentMs / MIN)} of ${Math.round(JOB_CAP_MS / MIN)} minutes spent`,
    );
    return { action: "ran", item: job.item, detail: `${stage} ${run.result}` };
  }

  succeed(job, stage, run.startedAt, run.endedAt, run.result === "nochange" ? "nochange" : "ok", run.exit);
  if (stage === "review" && parseVerdict(readArtifact(artifactPath(ctx, job.item, "review"))) === "clean") {
    // Nothing to fix: record the skip and go straight to delivery.
    job.history.push({
      stage: "fix",
      startedAt: new Date(ctx.deps.now()).toISOString(),
      endedAt: new Date(ctx.deps.now()).toISOString(),
      result: "skipped",
      exit: null,
      spentMs: 0,
    });
    job.stage = "deliver";
  }
  saveJob(ctx, job);
  ctx.deps.log(`[factory-jobs] #${job.item} ${stage} ok → ${job.stage}; ${Math.round(job.spentMs / MIN)} minutes spent`);
  return { action: "ran", item: job.item, detail: `${stage} ok` };
}

// ── start ─────────────────────────────────────────────────────────────────

export interface StartOutcome {
  action: "adopted" | "started" | "nothing" | "locked" | "conflict" | "stuck";
  item?: number;
  branch?: string;
  detail?: string;
}

/**
 * `git worktree add` refuses a branch that is still checked out in another worktree, and a
 * crash leaves exactly that behind. Prune the registrations whose directory is gone, and
 * report failure rather than throwing, so a `start` degrades instead of wedging every tick.
 */
function ensureWorktree(ctx: Ctx, path: string, addArgs: string[]): boolean {
  try {
    if (existsSync(path)) gitOrThrow(ctx, ["worktree", "remove", "--force", path]);
    else git(ctx, ["worktree", "prune"]);
    gitOrThrow(ctx, ["worktree", "add", ...addArgs]);
    provisionDeps(ctx, path);
    return true;
  } catch (err) {
    ctx.deps.log(
      `[factory-jobs] could not add a worktree at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * A worktree is a fresh checkout, so it arrives without `node_modules` — and every model
 * stage's contract is to run the suite and typecheck before it commits. Without an install
 * the stage either fails, or runs the suite in the *main* checkout and reports a green that
 * belongs to a different tree, which is the wrong-verification failure the ledger exists to
 * prevent. Hardlink the main tree's install rather than installing: measured at 39 ms and no
 * extra bytes for this repo's 152 MB, and still isolated, because `npm ci` in the worktree
 * replaces that directory while npm writes new files rather than editing in place, so the
 * main checkout keeps its own. A symlink is the tempting one-liner and is wrong: `npm ci`
 * would `rm -rf` through it and gut the install the tick itself runs on.
 */
function provisionDeps(ctx: Ctx, worktree: string): void {
  const source = resolve(ctx.root, "node_modules");
  const target = resolve(worktree, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;
  if (ctx.dryRun) {
    ctx.deps.log(`[dry-run] cp -al ${source} ${target}`);
    return;
  }
  const res = ctx.deps.exec("cp", ["-al", source, target], { cwd: ctx.root, timeoutMs: 2 * MIN });
  if (res.code !== 0) {
    // Not fatal: the worktree is usable, but a stage that runs the suite will fail on it.
    ctx.deps.log(
      `[factory-jobs] could not provision node_modules into ${worktree}: ${res.stderr.trim()}. ` +
        "Stages that run the suite or typecheck will fail until it is installed there.",
    );
  }
}

/** The base ref's own tip that was merged in (not the merge commit), or null on conflict. */
function mergeBaseRef(ctx: Ctx, worktree: string): string | null {
  const res = git(ctx, ["merge", "--no-edit", UPSTREAM_REF], worktree, 5 * MIN);
  if (res.code !== 0) {
    git(ctx, ["merge", "--abort"], worktree);
    return null;
  }
  return git(ctx, ["rev-parse", UPSTREAM_REF], worktree).stdout.trim();
}

function branchList(ctx: Ctx): string[] {
  const res = git(ctx, ["branch", "-a", "--format=%(refname:short)"]);
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("HEAD detached") && line !== "origin");
}

/** A label the build stage must respect, so an `auto:*` item cannot be widened by accident. */
function autoClassNote(item: BoardItem): string {
  const auto = item.labels.find((label) => (AUTO_LABELS as readonly string[]).includes(label));
  if (!auto) return "Its Status is `Approved`.";
  const scope: Record<string, string> = {
    "auto:docs": "`docs/` and comments only",
    "auto:changelog": "`CHANGELOG.md` only",
    "auto:tests": "tests only, never `src/`",
  };
  return `It carries \`${auto}\` (${scope[auto]}), which is the whole of its approval.`;
}

export async function startPass(ctx: Ctx): Promise<StartOutcome> {
  const lock = acquireLock(ctx);
  if (!lock) return { action: "locked" };
  try {
    const config = readProjectConfig(ctx.root);
    const jobs = loadJobs(ctx.jobsDir);
    const items = fetchBoard(ctx, config);
    const branches = branchList(ctx);

    const adopt = findAdoptable(items, jobs, {
      branches,
      commentsFor: (number) => fetchComments(ctx, config, number),
      hasCommits: (branch) => commitsAhead(ctx, branch) > 0,
      headOf: (branch) => git(ctx, ["rev-parse", "--short", branch]).stdout.trim() || null,
    });

    if (adopt) {
      const worktree = worktreePathFor(ctx.worktreeRoot, adopt.branch);
      if (!ctx.dryRun && !ensureWorktree(ctx, worktree, [worktree, adopt.branch])) {
        commentOn(
          ctx,
          config,
          adopt.item.number,
          `factory: could not create a worktree for \`${adopt.branch}\` at \`${worktree}\` (the branch may still be ` +
            `checked out somewhere else). Left for the owner; nothing was claimed.`,
        );
        return { action: "stuck", item: adopt.item.number, detail: `no worktree for ${adopt.branch}` };
      }
      // An adopted branch was cut before this job existed, so its tree still holds the stage
      // agent definitions of that day — and stages are discovered from the worktree, not from
      // the main checkout. Merging the base ref brings the tree (and the PR) up to date; a
      // conflict is the owner's call, and costs the job nothing.
      const mergedDev = ctx.dryRun ? BASE_REF : mergeBaseRef(ctx, worktree);
      if (mergedDev === null) {
        if (!ctx.dryRun) gitOrThrow(ctx, ["worktree", "remove", "--force", worktree]);
        commentOn(
          ctx,
          config,
          adopt.item.number,
          `factory: found the orphaned branch \`${adopt.branch}\` but merging \`${BASE_REF}\` into it conflicts, so the ` +
            `job was not opened. Resolve it (\`git merge ${UPSTREAM_REF}\`) and the next \`start\` will adopt it at ` +
            `\`${adopt.stage}\`.`,
        );
        ctx.deps.log(`[factory-jobs] adopted nothing: ${BASE_REF} does not merge cleanly into ${adopt.branch}`);
        return { action: "conflict", item: adopt.item.number, branch: adopt.branch, detail: `merge ${BASE_REF} conflicts` };
      }
      const job = newJob(ctx, adopt.item, {
        branch: adopt.branch,
        worktree,
        stage: adopt.stage,
        adoptedFrom: { branch: adopt.branch, commit: adopt.commit, mergedDev },
      });
      saveJob(ctx, job);
      setStatus(ctx, config, adopt.item, "In Progress");
      commentOn(
        ctx,
        config,
        adopt.item.number,
        `factory: adopted the orphaned branch \`${adopt.branch}\` at \`${adopt.commit ?? "no commits"}\`; ` +
          `re-entering the ledger at \`${adopt.stage}\`, with \`${UPSTREAM_REF}\` merged in at \`${mergedDev.slice(0, 7)}\` ` +
          `so the stage agents are current. The prior run's cost is not charged against the new budget.`,
      );
      ctx.deps.log(`[factory-jobs] adopted #${adopt.item.number} at ${adopt.stage} (${adopt.branch}, ${UPSTREAM_REF} merged)`);
      return { action: "adopted", item: adopt.item.number, branch: adopt.branch };
    }

    const candidate = pickCandidate(items, jobs);
    if (!candidate) {
      ctx.deps.log("[factory-jobs] nothing approved to start; no orphan to adopt either");
      return { action: "nothing" };
    }
    const branch = branchFor(candidate.number, candidate.title);
    const worktree = worktreePathFor(ctx.worktreeRoot, branch);
    if (!ctx.dryRun) {
      if (existsSync(worktree)) gitOrThrow(ctx, ["worktree", "remove", "--force", worktree]);
      if (!ensureWorktree(ctx, worktree, branches.includes(branch) ? [worktree, branch] : ["-b", branch, worktree, UPSTREAM_REF])) {
        return { action: "stuck", item: candidate.number, detail: `could not create the worktree at ${worktree}` };
      }
    }
    const job = newJob(ctx, candidate, { branch, worktree, stage: "build" });
    saveJob(ctx, job);
    setStatus(ctx, config, candidate, "In Progress");
    commentOn(
      ctx,
      config,
      candidate.number,
      `factory: claimed (branch ${branch})\n\nLedger job opened: stages build → review → fix → deliver, one per process, ` +
        `100 minutes total budget. ${autoClassNote(candidate)}`,
    );
    ctx.deps.log(`[factory-jobs] started #${candidate.number} at build (${branch})`);
    return { action: "started", item: candidate.number, branch };
  } finally {
    lock.release();
  }
}

function newJob(
  ctx: Ctx,
  item: BoardItem,
  over: {
    branch: string;
    worktree: string;
    stage: StageName;
    adoptedFrom?: { branch: string; commit: string | null; mergedDev?: string };
  },
): JobRecord {
  const nowIso = new Date(ctx.deps.now()).toISOString();
  const job: JobRecord = {
    schemaVersion: SCHEMA_VERSION,
    item: item.number,
    title: item.title,
    priority: item.priority,
    milestone: item.milestone,
    branch: over.branch,
    worktree: over.worktree,
    baseRef: BASE_REF,
    stage: over.stage,
    stageState: "ready",
    attempts: {},
    spentMs: 0,
    claim: null,
    artifacts: {},
    pr: null,
    startedAt: nowIso,
    updatedAt: nowIso,
    history: [],
  };
  if (over.adoptedFrom) job.adoptedFrom = over.adoptedFrom;
  return job;
}

// ── retry, and the read-only commands ─────────────────────────────────────

export function retryPass(ctx: Ctx, item: number): { ok: boolean; detail: string } {
  const lock = acquireLock(ctx);
  if (!lock) return { ok: false, detail: "the drain lock is held; try again after the tick" };
  try {
    const config = readProjectConfig(ctx.root);
    const job = loadJobs(ctx.jobsDir).find((j) => j.item === item);
    if (!job) return { ok: false, detail: `no job record for #${item}` };
    const before = { attempts: job.attempts, spentMs: job.spentMs, stageState: job.stageState };
    job.attempts = {};
    job.spentMs = 0;
    job.stageState = "ready";
    job.claim = null;
    job.waitingSince = undefined;
    job.history.push({
      stage: job.stage,
      startedAt: new Date(ctx.deps.now()).toISOString(),
      endedAt: new Date(ctx.deps.now()).toISOString(),
      result: "retried",
      exit: null,
      spentMs: 0,
    });
    saveJob(ctx, job);
    resumeItem(ctx, config, job);
    commentOn(
      ctx,
      config,
      item,
      `factory: retried by the owner — attempts and budget reset. Was ${JSON.stringify(before)}.`,
    );
    return { ok: true, detail: `#${item} reset at ${job.stage} with a full ${Math.round(JOB_CAP_MS / MIN)} minutes` };
  } finally {
    lock.release();
  }
}

export function listJobs(ctx: Ctx): string {
  const jobs = loadJobs(ctx.jobsDir);
  if (!jobs.length) return "no jobs in the ledger";
  const rows = jobs.map((job) => [
    `#${job.item}`,
    job.stage,
    job.stageState,
    `spent ${Math.round(job.spentMs / MIN)}m`,
    `attempts ${JSON.stringify(job.attempts)}`,
    job.pr ? `pr #${job.pr}` : "no pr",
    job.branch,
  ]);
  const columns = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((row) => (row[i] ?? "").length)),
  );
  return rows.map((row) => row.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

export function staleReport(ctx: Ctx): string {
  const now = ctx.deps.now();
  const lines: string[] = [];
  for (const job of loadJobs(ctx.jobsDir)) {
    if (job.stageState === "running" && probeClaim(job.claim, ctx.deps.live) !== "live") {
      lines.push(`orphan record: #${job.item} says running at ${job.stage}, but its process is gone`);
    }
    if (job.stageState === "waiting" && job.waitingSince) {
      const waited = now - Date.parse(job.waitingSince);
      if (waited > WAITING_STALE_MS) {
        lines.push(
          `waiting on the merge: #${job.item} PR #${job.pr} has been open ${Math.round(waited / (24 * 60 * MIN))} days`,
        );
      }
    }
  }
  return lines.length ? lines.join("\n") : "nothing stale";
}

// ── Housekeeping: a fresh base, no stale branches ─────────────────────────

export interface BranchesReport {
  branch: string;
  /** The tip it was deleted (or kept) at, so the operation can be audited or undone. */
  commit: string;
  reason: string;
}

export interface HousekeepingOutcome {
  fetched: boolean;
  /** What happened to the local `dev` ref: the worktree fork point must not rot. */
  devRef: "already-current" | "advanced" | "behind-but-unsafe" | "unknown";
  devRefBehind: number;
  deleted: BranchesReport[];
  kept: BranchesReport[];
}

/**
 * The one command that tidies the checkout instead of advancing a job. Three things: fetch,
 * so nothing forks from a stale base; fast-forward the local `dev` ref when that is provably
 * safe; delete local branches whose work is already in `dev`.
 *
 * It never deletes on ancestry alone. This repo squash-merges, so a merged branch is not an
 * ancestor of dev — `git branch -d` refuses it, and a naive `-D` would delete real work. The
 * predicate is the branch's own **merged PR**, or full containment in `origin/dev`. The
 * exclusions are the current branch, `dev`/`main`/`master`, anything checked out in a
 * worktree, and any branch a live job record names. Nothing remote is touched: deleting the
 * remote branch is the owner's affordance on the PR page, and `git fetch` cannot undo it.
 *
 * Failures here are reported, never thrown: this runs beside the drain, and hygiene must not
 * fail a tick that advanced a job.
 */
export function housekeeping(ctx: Ctx): HousekeepingOutcome {
  const outcome: HousekeepingOutcome = { fetched: false, devRef: "unknown", devRefBehind: 0, deleted: [], kept: [] };
  if (ctx.dryRun) {
    // Reading is fine, moving refs is not: decide against the refs as they stand.
    ctx.deps.log("[dry-run] git fetch origin --prune");
    outcome.fetched = true;
    outcome.devRefBehind = behindCount(ctx);
    outcome.devRef = advanceLocalBase(ctx, outcome.devRefBehind);
    pruneMergedBranches(ctx, outcome);
    return outcome;
  }
  const fetch = git(ctx, ["fetch", "origin", "--prune", "--quiet"], ctx.root, 2 * MIN);
  outcome.fetched = fetch.code === 0;
  if (!outcome.fetched) {
    ctx.deps.log(`[factory-jobs] fetch failed, so nothing is pruned on stale information: ${fetch.stderr.trim()}`);
    return outcome;
  }
  // A worktree registration whose directory is gone blocks its branch from being reused.
  if (!ctx.dryRun) git(ctx, ["worktree", "prune"], ctx.root);

  outcome.devRefBehind = behindCount(ctx);
  outcome.devRef = advanceLocalBase(ctx, outcome.devRefBehind);
  pruneMergedBranches(ctx, outcome);
  return outcome;
}

/** How many commits the local base ref is behind the tracked one. */
function behindCount(ctx: Ctx): number {
  const raw = git(ctx, ["rev-list", "--count", `${BASE_REF}..${UPSTREAM_REF}`]).stdout.trim() || "0";
  const behind = Number.parseInt(raw, 10);
  return Number.isFinite(behind) ? behind : 0;
}

/** Move the local base ref to the tracked one, but only where that cannot lose work. */
function advanceLocalBase(ctx: Ctx, behind: number): HousekeepingOutcome["devRef"] {
  if (behind === 0) return "already-current";
  if (ctx.dryRun) {
    ctx.deps.log(`[dry-run] ${BASE_REF} is ${behind} behind ${UPSTREAM_REF}`);
    return "behind-but-unsafe";
  }
  const head = currentBranch(ctx);
  if (head === BASE_REF) {
    // Checked out here, so the ref can only move through the working tree. A dirty tree is
    // someone mid-edit: refuse rather than surprise them.
    if (porcelain(ctx, ctx.root)) {
      ctx.deps.log(`[factory-jobs] ${BASE_REF} is ${behind} behind and this checkout is dirty; left alone`);
      return "behind-but-unsafe";
    }
    const merged = git(ctx, ["merge", "--ff-only", UPSTREAM_REF]);
    if (merged.code === 0) {
      ctx.deps.log(`[factory-jobs] fast-forwarded ${BASE_REF} by ${behind}`);
      return "advanced";
    }
    ctx.deps.log(`[factory-jobs] ${BASE_REF} is behind but not fast-forwardable: ${merged.stderr.trim()}`);
    return "behind-but-unsafe";
  }
  // Not checked out here: move the ref itself, which git refuses unless it is a fast-forward.
  const res = git(ctx, ["fetch", "origin", `${BASE_REF}:${BASE_REF}`]);
  if (res.code === 0) {
    ctx.deps.log(`[factory-jobs] advanced the local ${BASE_REF} ref by ${behind} (not checked out here)`);
    return "advanced";
  }
  ctx.deps.log(`[factory-jobs] could not advance ${BASE_REF}: ${res.stderr.trim()}`);
  return "behind-but-unsafe";
}

function currentBranch(ctx: Ctx): string {
  return git(ctx, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
}

/** Head branches of merged PRs, or null when gh could not answer (so: prune nothing). */
/** A merged PR, identified by the commit its head was at when it merged. */
interface MergedPrRef {
  number: number;
  headOid: string;
}

/** How many merged PRs one bulk query asks for. See `mergedPrsByHead`. */
const MERGED_PR_PAGE = 1000;

interface MergedPrIndex {
  byHead: Map<string, MergedPrRef[]>;
  /**
   * False when the bulk query returned exactly the page size, i.e. it may have been cut off.
   * A complete index is authoritative: a branch missing from it has no merged PR at all. A
   * possibly-truncated one falls back to a per-branch query, so the page size can only ever
   * cost an extra call, never a wrong decision.
   */
  complete: boolean;
}

function mergedPrsByHead(ctx: Ctx, repo: string): MergedPrIndex | null {
  let raw: string;
  try {
    raw = gh(ctx, [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--limit",
      String(MERGED_PR_PAGE),
      "--json",
      "number,headRefName,headRefOid",
    ]);
  } catch (err) {
    ctx.deps.log(`[factory-jobs] cannot list merged PRs: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let prs: { number?: number; headRefName?: string; headRefOid?: string }[];
  try {
    prs = JSON.parse(raw || "[]") as { number?: number; headRefName?: string; headRefOid?: string }[];
  } catch {
    ctx.deps.log("[factory-jobs] gh returned unparseable JSON for the merged PR list; pruning nothing");
    return null;
  }
  const byHead = new Map<string, MergedPrRef[]>();
  for (const pr of prs) {
    if (!pr.headRefName || !pr.headRefOid) continue;
    const list = byHead.get(pr.headRefName) ?? [];
    list.push({ number: pr.number ?? 0, headOid: pr.headRefOid });
    byHead.set(pr.headRefName, list);
  }
  return { byHead, complete: prs.length < MERGED_PR_PAGE };
}

/** Merged PRs for one head, asked directly. Only needed when the bulk page may be truncated. */
function mergedPrsForHead(ctx: Ctx, repo: string, branch: string): MergedPrRef[] {
  try {
    const raw = gh(ctx, [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "merged",
      "--limit",
      "10",
      "--json",
      "number,headRefOid",
    ]);
    const prs = JSON.parse(raw || "[]") as { number?: number; headRefOid?: string }[];
    const refs: MergedPrRef[] = [];
    for (const pr of prs) {
      if (pr.headRefOid) refs.push({ number: pr.number ?? 0, headOid: pr.headRefOid });
    }
    return refs;
  } catch (err) {
    ctx.deps.log(
      `[factory-jobs] cannot list merged PRs for ${branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function pruneMergedBranches(ctx: Ctx, outcome: HousekeepingOutcome): void {
  let repo: string;
  try {
    repo = readProjectConfig(ctx.root).repo;
  } catch (err) {
    ctx.deps.log(`[factory-jobs] cannot read the board config: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const index = mergedPrsByHead(ctx, repo);
  if (!index) return;

  const locals: string[] = [];
  for (const line of git(ctx, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]).stdout.split("\n")) {
    const name = line.trim();
    if (name) locals.push(name);
  }
  const head = currentBranch(ctx);
  const checkedOut = new Set(
    git(ctx, ["worktree", "list", "--porcelain"])
      .stdout.split("\n")
      .filter((line) => line.startsWith("branch refs/heads/"))
      .map((line) => line.replace("branch refs/heads/", "").trim()),
  );
  const liveJobBranches = new Set(loadJobs(ctx.jobsDir).map((job) => job.branch));

  for (const branch of locals) {
    const keep = (commit: string, reason: string): void => {
      outcome.kept.push({ branch, commit, reason });
    };
    const excluded = untouchableReason(branch, { head, checkedOut, live: liveJobBranches });
    if (excluded) {
      keep("", excluded);
      continue;
    }

    const tip = git(ctx, ["rev-parse", "--verify", `${branch}^{commit}`]).stdout.trim();
    if (!tip) {
      keep("", "could not resolve its tip");
      continue;
    }

    // Safe on its own: every commit on the branch is already in the tracked ref.
    if (git(ctx, ["merge-base", "--is-ancestor", branch, UPSTREAM_REF]).code === 0) {
      removeBranch(ctx, outcome, branch, tip, "-d", `contained in ${UPSTREAM_REF}`);
      continue;
    }

    // Otherwise its work can only have landed as a squash, and that is proven by a merged PR
    // whose head was *exactly this tip*. A branch name is not proof: `feat/<item>-<slug>` is
    // deterministic, so a redone item recreates a name an older merged PR already owns, and
    // a branch that advanced after its own merge carries commits no PR ever saw.
    const prs = index.byHead.get(branch) ?? (index.complete ? [] : mergedPrsForHead(ctx, repo, branch));
    const merged = prs.find((pr) => pr.headOid === tip);
    if (!merged) {
      const other = prs[0];
      keep(
        tip,
        other
          ? `its tip differs from merged PR #${other.number}'s head ${other.headOid.slice(0, 7)}`
          : "not merged",
      );
      continue;
    }
    removeBranch(ctx, outcome, branch, tip, "-D", `PR #${merged.number} merged at this exact commit`);
  }
}

/** Why a branch is never a pruning candidate, whatever git says about its commits. */
function untouchableReason(
  branch: string,
  seen: { head: string; checkedOut: Set<string>; live: Set<string> },
): string | null {
  if (PROTECTED_BRANCHES.has(branch)) return "protected";
  if (branch === seen.head) return "checked out here";
  if (seen.checkedOut.has(branch)) return "checked out in a worktree";
  if (seen.live.has(branch)) return "a live job owns it";
  return null;
}

/**
 * `-d` where ancestry already proved containment; `-D` only when the tip-equality proof was
 * logged first, so a forced delete always has its evidence in the journal beside it.
 */
function removeBranch(
  ctx: Ctx,
  outcome: HousekeepingOutcome,
  branch: string,
  tip: string,
  flag: "-d" | "-D",
  proof: string,
): void {
  if (ctx.dryRun) {
    ctx.deps.log(`[dry-run] git branch ${flag} ${branch} at ${tip.slice(0, 7)} (${proof})`);
    outcome.deleted.push({ branch, commit: tip, reason: proof });
    return;
  }
  let res = git(ctx, ["branch", "-d", branch]);
  if (res.code !== 0 && flag === "-D") {
    ctx.deps.log(`[factory-jobs] ${branch} is not an ancestor of ${UPSTREAM_REF}; forcing: ${proof}`);
    res = git(ctx, ["branch", "-D", branch]);
  }
  if (res.code === 0) {
    outcome.deleted.push({ branch, commit: tip, reason: proof });
    ctx.deps.log(`[factory-jobs] deleted merged branch ${branch} at ${tip.slice(0, 7)} (${proof})`);
  } else {
    outcome.kept.push({ branch, commit: tip, reason: `delete failed: ${res.stderr.trim()}` });
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

export interface Options {
  command: string;
  item?: number;
}

export function parseArgs(argv: string[]): Options {
  const [command = "help", ...rest] = argv;
  const item = rest.find((a) => /^\d+$/.test(a));
  return item ? { command, item: Number(item) } : { command };
}

const USAGE = `Dark Factory job ledger

  tsx scripts/factory-jobs.ts start          claim or adopt one item, open its job
  tsx scripts/factory-jobs.ts drain          the tick's one action
  tsx scripts/factory-jobs.ts retry <item>   owner unblock: attempts and budget reset
  tsx scripts/factory-jobs.ts list           every live job, one line each
  tsx scripts/factory-jobs.ts show <item>    one job's record
  tsx scripts/factory-jobs.ts stale          orphans, and PRs open over a week
  tsx scripts/factory-jobs.ts housekeeping   fetch, freshen local dev, prune merged branches

  FACTORY_DRY_RUN=1        spawn nothing, write nothing
  FACTORY_JOBS_DIR=<dir>   use a scratch ledger instead of .pi/factory/jobs`;

export function buildCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const root = resolveRepoRoot({ env });
  return {
    root,
    jobsDir: jobsDirFor(root, env),
    worktreeRoot: worktreeRootFor(root, env),
    dryRun: env.FACTORY_DRY_RUN === "1" || env.FACTORY_DRY_RUN === "true",
    deps: defaultDeps(env),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = buildCtx();
  if (ctx.dryRun) ctx.deps.log("[factory-jobs] dry run: nothing will be spawned, written or pushed");
  switch (opts.command) {
    case "start":
      ctx.deps.log(JSON.stringify(await startPass(ctx)));
      break;
    case "drain":
      ctx.deps.log(JSON.stringify(await drainOnce(ctx)));
      break;
    case "retry": {
      if (opts.item === undefined) throw new Error("retry needs an item number");
      const res = retryPass(ctx, opts.item);
      ctx.deps.log(res.detail);
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case "list":
      ctx.deps.log(listJobs(ctx));
      break;
    case "show": {
      if (opts.item === undefined) throw new Error("show needs an item number");
      const path = jobPath(ctx.jobsDir, opts.item);
      ctx.deps.log(existsSync(path) ? readFileSync(path, "utf8") : `no job record for #${opts.item}`);
      break;
    }
    case "stale":
      ctx.deps.log(staleReport(ctx));
      break;
    case "housekeeping":
      ctx.deps.log(JSON.stringify(housekeeping(ctx)));
      break;
    default:
      process.stdout.write(`${USAGE}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[factory-jobs] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
