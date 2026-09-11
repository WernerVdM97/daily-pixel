import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_LABELS,
  BASE_REF,
  type BoardItem,
  UPSTREAM_REF,
  type Claim,
  type Ctx,
  type Deps,
  type Exec,
  type ExecResult,
  type JobRecord,
  JOB_CAP_MS,
  type Liveness,
  SCHEMA_VERSION,
  type StageName,
  type StageRun,
  acquireLock,
  attemptTimeoutMs,
  branchFor,
  claimedBranch,
  decide,
  deliverCommands,
  drainOnce,
  findAdoptable,
  housekeeping,
  isGated,
  listJobs,
  loadJobs,
  parseVerdict,
  pickCandidate,
  probeClaim,
  resolveRepoRoot,
  retryPass,
  staleReport,
  worktreePathFor,
} from '../../scripts/factory-jobs.js';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const MIN = 60_000;
const T0 = Date.parse('2026-09-11T12:00:00Z');

// ── A board item, a job record, and a harness ─────────────────────────────

function item(over: Partial<BoardItem> & { number: number }): BoardItem {
  return {
    itemId: `PVTI_${over.number}`,
    title: `Item ${over.number}`,
    url: `https://example.test/issues/${over.number}`,
    status: 'Approved',
    priority: 'P2 - normal',
    milestone: 'v0.3.x polish',
    labels: [],
    ...over,
  };
}

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    item: 34,
    title: 'Last stand buttons/captions',
    priority: 'P2 - normal',
    milestone: 'v0.3.x polish',
    branch: 'feat/34-last-stand',
    worktree: '/tmp/factory-test/feat-34-last-stand',
    baseRef: BASE_REF,
    stage: 'build',
    stageState: 'ready',
    attempts: {},
    spentMs: 0,
    claim: null,
    artifacts: {},
    pr: null,
    startedAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T10:00:00.000Z',
    history: [],
    ...over,
  };
}

interface Call {
  cmd: string;
  args: string[];
}

type Handler = (cmd: string, args: string[]) => ExecResult | null;

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'factory-jobs-'));
  readonly root: string;
  readonly jobsDir: string;
  readonly calls: Call[] = [];
  readonly logs: string[] = [];
  readonly spawns: StageRun[] = [];
  readonly killed: number[] = [];
  readonly pages: string[] = [];
  nowMs = T0;
  live: Liveness = { startTime: () => null };
  board: BoardItem[] = [];
  /** What the fake stage child writes to its report file, per stage. */
  reports: Partial<Record<StageName, string>> = { build: 'built', review: 'VERDICT: findings', fix: 'VERDICT: ok' };
  /** Exit code and timeout the fake stage returns. */
  stageOutcome: { code: number | null; timedOut: boolean } = { code: 0, timedOut: false };
  /** How long the fake stage appears to take, so the clock charges a real slice. */
  stageDurationMs = 12 * MIN;
  /** Runs inside the fake stage, for effects the drainer must notice after it returns. */
  afterSpawn?: (run: StageRun) => void;
  /** Repo shape the housekeeping pass reasons about. */
  branches: string[] = [];
  worktreeBranches: string[] = [];
  currentBranch = 'feat/34-last-stand';
  devBehind = 0;
  /** Merged PRs as gh reports them: the head ref *and* the commit that head was at. */
  mergedPrs: { branch: string; oid: string; number: number }[] = [];
  /** Branch tips, when they differ from `branchSha`. */
  tips: Record<string, string> = {};
  /** Pretend the bulk merged-PR page came back full, so the index cannot be trusted. */
  bulkTruncated = false;
  /** Branches already wholly contained in the tracked ref (no squash involved). */
  ancestors = new Set<string>();
  /** The branch the job is on, and its tip: a committing stage moves the tip. */
  jobBranch = 'feat/34-last-stand';
  branchSha = 'aaaaaaa';
  stageCommits = true;

  dirtyWorktree = '';
  private handlers: Handler[] = [];

  constructor() {
    this.root = join(this.dir, 'repo');
    this.jobsDir = join(this.dir, 'jobs');
    mkdirSync(this.jobsDir, { recursive: true });
    mkdirSync(join(this.root, '.pi/factory'), { recursive: true });
    writeFileSync(
      join(this.root, '.pi/factory/project.json'),
      readFileSync(join(REPO_ROOT, '.pi/factory/project.json')),
    );
  }

  when(cmd: string, argsPrefix: string[], result: ExecResult): this {
    const prefix = argsPrefix.join(' ');
    this.handlers.push((seen, args) => (seen === cmd && args.join(' ').startsWith(prefix) ? result : null));
    return this;
  }

  /** A well-behaved fake child: writes its report, then exits. */
  readonly deps = (): Deps => ({
    now: () => this.nowMs,
    exec: ((cmd, args) => this.execSync(cmd, args)) as Exec,
    live: { startTime: (pid) => this.live.startTime(pid) },
    spawnStage: async (run) => {
      this.spawns.push(run);
      this.nowMs += this.stageDurationMs;
      if ((run.stage === 'build' || run.stage === 'fix') && this.stageCommits) this.branchSha = 'bbbbbbb';
      this.afterSpawn?.(run);
      const report = this.reports[run.stage];
      if (report !== undefined) {
        const path = join(this.jobsDir, 'artifacts', String(run.item), `${run.stage}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, report);
      }
      return { code: this.stageOutcome.code, timedOut: this.stageOutcome.timedOut, stdout: '', stderr: '' };
    },
    killGroup: (pid) => {
      this.killed.push(pid);
    },
    log: (msg) => {
      this.logs.push(msg);
    },
    page: (title, body) => {
      this.pages.push(`${title}\n${body}`);
    },
  });

  private execSync(cmd: string, args: string[]): ExecResult {
    this.calls.push({ cmd, args });
    if (cmd === 'gh' && args.join(' ').startsWith('project item-list')) {
      return ok(JSON.stringify({ items: this.board.map(toRawItem) }));
    }
    if (cmd === 'git' && args.join(' ') === `rev-parse ${this.jobBranch}`) return ok(`${this.branchSha}\n`);
    if (cmd === 'git' && args.join(' ') === `rev-list --count ${BASE_REF}..${UPSTREAM_REF}`) {
      return ok(`${this.devBehind}\n`);
    }
    if (cmd === 'git' && args.join(' ') === 'status --porcelain') return ok(this.dirtyWorktree);
    if (cmd === 'git' && args[0] === 'symbolic-ref') return ok(this.currentBranch ? `${this.currentBranch}\n` : '');
    if (cmd === 'git' && args[0] === 'for-each-ref') return ok(this.branches.map((b) => `${b}\n`).join(''));
    if (cmd === 'git' && args.join(' ') === 'worktree list --porcelain') {
      return ok(this.worktreeBranches.map((b) => `worktree /tmp/wt\nbranch refs/heads/${b}\n\n`).join(''));
    }
    // A branch containment probe (`merge-base --is-ancestor <branch> origin/dev`).
    if (cmd === 'git' && args[0] === 'merge-base') {
      return this.ancestors.has(args[2] ?? '') ? ok('') : { code: 1, stdout: '', stderr: 'not an ancestor' };
    }
    if (cmd === 'gh' && args.join(' ').startsWith('pr list') && args.includes('merged')) {
      const heads = args.indexOf('--head');
      const only = heads === -1 ? null : args[heads + 1];
      if (!only && this.bulkTruncated) {
        const page = Array.from({ length: 1000 }, (_, i) => ({
          number: i + 1,
          headRefName: `bulk/${i}`,
          headRefOid: 'b',
        }));
        return ok(JSON.stringify(page));
      }
      const rows = this.mergedPrs
        .filter((pr) => (only ? pr.branch === only : true))
        .map((pr) => ({ number: pr.number, headRefName: pr.branch, headRefOid: pr.oid }));
      return ok(JSON.stringify(rows));
    }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
      const name = (args[2] ?? '').replace(/\^\{commit\}$/, '');
      return ok(`${this.tips[name] ?? this.branchSha}\n`);
    }
    // `git branch -d` refuses anything not fully merged; `-D` forces it.
    if (cmd === 'git' && args[0] === 'branch' && (args[1] === '-d' || args[1] === '-D')) {
      const name = args[2] ?? '';
      if (args[1] === '-d' && !this.ancestors.has(name)) {
        return { code: 1, stdout: '', stderr: `error: the branch '${name}' is not fully merged` };
      }
      return ok('');
    }
    for (const handler of this.handlers) {
      const hit = handler(cmd, args);
      if (hit) return hit;
    }
    return ok('');
  }

  ctx(over: Partial<Ctx> = {}): Ctx {
    return {
      root: this.root,
      jobsDir: this.jobsDir,
      worktreeRoot: join(this.dir, 'worktrees'),
      dryRun: false,
      deps: this.deps(),
      ...over,
    };
  }

  write(jobRecord: JobRecord): void {
    writeFileSync(join(this.jobsDir, `${jobRecord.item}.json`), JSON.stringify(jobRecord, null, 2));
  }

  read(itemNumber: number): JobRecord {
    return JSON.parse(readFileSync(join(this.jobsDir, `${itemNumber}.json`), 'utf8')) as JobRecord;
  }

  archived(itemNumber: number): JobRecord {
    return JSON.parse(readFileSync(join(this.jobsDir, 'archive', `${itemNumber}.json`), 'utf8')) as JobRecord;
  }

  has(itemNumber: number): boolean {
    return readdirSync(this.jobsDir).includes(`${itemNumber}.json`);
  }

  /** Command lines the fake exec saw, for asserting what the ledger asked gh and git to do. */
  called(cmd: string, prefix: string): boolean {
    return this.calls.some((call) => call.cmd === cmd && call.args.join(' ').startsWith(prefix));
  }
}

function ok(stdout = ''): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

function toRawItem(entry: BoardItem): unknown {
  return {
    id: entry.itemId,
    status: entry.status,
    priority: entry.priority,
    labels: entry.labels,
    milestone: { title: entry.milestone },
    content: { number: entry.number, title: entry.title, url: entry.url },
  };
}

// ── The gate and the pick ─────────────────────────────────────────────────

describe('the gate', () => {
  it('admits Approved, and only the auto:* classes', () => {
    expect(isGated(item({ number: 1, status: 'Approved' }))).toBe(true);
    for (const label of AUTO_LABELS) {
      expect(isGated(item({ number: 1, status: 'Inbox', labels: [label] }))).toBe(true);
    }
    expect(isGated(item({ number: 1, status: 'Inbox' }))).toBe(false);
    expect(isGated(item({ number: 1, status: 'Triaged' }))).toBe(false);
    expect(isGated(item({ number: 1, status: 'Blocked', labels: ['auto:docs'] }))).toBe(false);
    expect(isGated(item({ number: 1, status: 'Done', labels: ['auto:docs'] }))).toBe(false);
  });

  it('picks by priority then oldest, and never Inbox or Blocked without a label', () => {
    const board = [
      item({ number: 90, status: 'Approved', priority: 'P2 - normal' }),
      item({ number: 12, status: 'Approved', priority: 'P1 - high' }),
      item({ number: 7, status: 'Approved', priority: 'P1 - high' }),
      item({ number: 5, status: 'Inbox' }),
      item({ number: 6, status: 'Blocked', labels: ['auto:tests'] }),
      item({ number: 8, status: 'Done' }),
    ];
    expect(pickCandidate(board, [])?.number).toBe(7);
  });

  it('skips an item that already has a job', () => {
    const board = [item({ number: 7, status: 'Approved', priority: 'P1 - high' }), item({ number: 9, status: 'Approved' })];
    expect(pickCandidate(board, [job({ item: 7 })])?.number).toBe(9);
  });

  it('runs an auto:* item ahead of nothing, at Inbox or Triaged', () => {
    const board = [item({ number: 3, status: 'Triaged', labels: ['auto:changelog'], priority: 'P3 - low' })];
    expect(pickCandidate(board, [])?.number).toBe(3);
  });
});

// ── Adoption ──────────────────────────────────────────────────────────────

describe('adoption', () => {
  const comments = (body: string) => [{ body }];

  it('takes over an orphan named in the factory claim comment', () => {
    expect(claimedBranch(comments('factory: claimed (branch feat/34-last-stand)'), 34, ['feat/34-last-stand'])).toBe(
      'feat/34-last-stand',
    );
    expect(
      claimedBranch(comments('factory: claimed (branch feat/34-last-stand)'), 34, ['origin/feat/34-last-stand']),
    ).toBe('feat/34-last-stand');
  });

  it('falls back to a branch carrying the item number', () => {
    expect(claimedBranch([], 34, ['dev', 'feat/34-last-stand-emojis'])).toBe('feat/34-last-stand-emojis');
    expect(claimedBranch([], 34, ['dev', 'feat/33-something'])).toBeNull();
  });

  it('enters at review when the branch has commits ahead of dev, else at build', () => {
    const orphans = [item({ number: 34, status: 'In Progress' })];
    const withCommits = findAdoptable(orphans, [], {
      branches: ['feat/34-last-stand'],
      commentsFor: () => comments('factory: claimed (branch feat/34-last-stand)'),
      hasCommits: () => true,
      headOf: () => '31eb9e3',
    });
    expect(withCommits).toMatchObject({ stage: 'review', commit: '31eb9e3', branch: 'feat/34-last-stand' });

    const withoutCommits = findAdoptable(orphans, [], {
      branches: ['feat/34-last-stand'],
      commentsFor: () => comments('factory: claimed (branch feat/34-last-stand)'),
      hasCommits: () => false,
      headOf: () => null,
    });
    expect(withoutCommits).toMatchObject({ stage: 'build', commit: null });
  });

  it('leaves an In Progress item with no claim and no branch for the sweeper', () => {
    const adopt = findAdoptable([item({ number: 40, status: 'In Progress' })], [], {
      branches: ['dev', 'main'],
      commentsFor: () => [],
      hasCommits: () => true,
      headOf: () => 'abc',
    });
    expect(adopt).toBeNull();
  });

  it('never takes an item that already has a record', () => {
    const adopt = findAdoptable([item({ number: 34, status: 'In Progress' })], [job({ item: 34 })], {
      branches: ['feat/34-last-stand'],
      commentsFor: () => comments('factory: claimed (branch feat/34-last-stand)'),
      hasCommits: () => true,
      headOf: () => 'abc',
    });
    expect(adopt).toBeNull();
  });
});

// ── The state machine ─────────────────────────────────────────────────────

describe('the attempt budget', () => {
  it('caps an attempt at min(stage budget, what is left)', () => {
    expect(attemptTimeoutMs(job({ stage: 'build' }))).toBe(50 * MIN);
    expect(attemptTimeoutMs(job({ stage: 'review', spentMs: 91 * MIN }))).toBe(9 * MIN);
    expect(attemptTimeoutMs(job({ stage: 'fix', spentMs: 99 * MIN }))).toBe(MIN);
  });

  it('blocks rather than refunds when the cap is spent', () => {
    const spent = job({ stage: 'fix', spentMs: JOB_CAP_MS });
    expect(decide(spent, { startTime: () => null })).toMatchObject({ kind: 'block' });
  });

  it('blocks the third attempt at one stage', () => {
    expect(decide(job({ attempts: { build: 2 } }), { startTime: () => null })).toMatchObject({ kind: 'block' });
    expect(decide(job({ attempts: { build: 1 } }), { startTime: () => null })).toMatchObject({ kind: 'run' });
  });

  it('runs a ready stage, skips a blocked one and a waiting one', () => {
    const live: Liveness = { startTime: () => null };
    expect(decide(job(), live)).toMatchObject({ kind: 'run', timeoutMs: 50 * MIN });
    expect(decide(job({ stageState: 'blocked', pagedAt: '2026-09-11T11:00:00.000Z' }), live)).toMatchObject({
      kind: 'skip',
    });
    // Blocked with no page on record: the tick that blocked it died first, so page it again.
    expect(decide(job({ stageState: 'blocked' }), live)).toMatchObject({ kind: 'page' });
    expect(decide(job({ stage: 'reconcile', stageState: 'waiting' }), live)).toMatchObject({ kind: 'skip' });
  });
});

describe('liveness', () => {
  it('proves a claim only on a matching start time', () => {
    const claim: Claim = { pid: 50839, pidStart: '8123' };
    expect(probeClaim(claim, { startTime: () => '8123' })).toBe('live');
    expect(probeClaim(claim, { startTime: () => '9999' })).toBe('recycled');
    expect(probeClaim(claim, { startTime: () => null })).toBe('dead');
    expect(probeClaim({ pid: 1, pidStart: null }, { startTime: () => 'anything' })).toBe('recycled');
    expect(probeClaim(null, { startTime: () => '8123' })).toBe('none');
  });

  it('reaps a genuine orphan, and requeues one whose pid was recycled', () => {
    const live: Liveness = { startTime: (pid) => (pid === 11 ? 'aaa' : 'zzz') };
    const orphan = job({ stageState: 'running', stage: 'review', claim: { pid: 11, pidStart: 'aaa' }, stageStartedAt: '2026-09-11T11:40:00.000Z' });
    expect(decide(orphan, live)).toMatchObject({ kind: 'reap' });

    const recycled = job({ stageState: 'running', claim: { pid: 11, pidStart: 'bbb' }, stageStartedAt: '2026-09-11T11:40:00.000Z' });
    expect(decide(recycled, live)).toMatchObject({ kind: 'requeue' });
  });

  it('counts a drainer that died with its stage, and charges its elapsed time', async () => {
    const h = new Harness();
    h.write(job({ stageState: 'running', stage: 'build', claim: null, stageStartedAt: '2026-09-11T11:40:00.000Z' }));
    const outcome = await drainOnce(h.ctx());
    expect(outcome).toMatchObject({ action: 'requeued', item: 34 });
    const after = h.read(34);
    expect(after.attempts.build).toBe(1);
    expect(after.stageState).toBe('ready');
    expect(after.spentMs).toBe(20 * MIN);
    expect(after.history.at(-1)).toMatchObject({ result: 'failed', stage: 'build' });
    expect(h.killed).toEqual([]);
  });

  it('kills a genuine orphan as a group and counts the attempt', async () => {
    const h = new Harness();
    h.live = { startTime: (pid) => (pid === 4242 ? '8123' : null) };
    h.write(
      job({
        stageState: 'running',
        stage: 'build',
        claim: { pid: 4242, pidStart: '8123' },
        stageStartedAt: '2026-09-11T11:30:00.000Z',
      }),
    );
    const outcome = await drainOnce(h.ctx());
    expect(outcome).toMatchObject({ action: 'reaped' });
    expect(h.killed).toEqual([4242]);
    expect(h.read(34).attempts.build).toBe(1);
  });

  it('never kills a recycled pid, and still counts the attempt', async () => {
    const h = new Harness();
    h.live = { startTime: () => 'different' };
    h.write(
      job({
        stageState: 'running',
        claim: { pid: 4242, pidStart: '8123' },
        stageStartedAt: '2026-09-11T11:55:00.000Z',
      }),
    );
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'requeued' });
    expect(h.killed).toEqual([]);
    expect(h.read(34).attempts.build).toBe(1);
  });
});

// ── Locking ───────────────────────────────────────────────────────────────

describe('the drain lock', () => {
  it('makes a second drain exit on the lock rather than wait', async () => {
    const h = new Harness();
    writeFileSync(join(h.jobsDir, '.drain.lock'), `${JSON.stringify({ pid: 4242, pidStart: 'live' })}\n`);
    h.live = { startTime: (pid) => (pid === 4242 ? 'live' : null) };
    h.write(job());
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'locked' });
    expect(h.spawns).toEqual([]);
  });

  it('takes over a lock whose holder is gone', () => {
    const h = new Harness();
    writeFileSync(join(h.jobsDir, '.drain.lock'), `${JSON.stringify({ pid: 4242, pidStart: 'gone' })}\n`);
    const lock = acquireLock(h.ctx());
    expect(lock).not.toBeNull();
    lock?.release();
    expect(readdirSync(h.jobsDir)).not.toContain('.drain.lock');
  });

  it('fails a start soft when the lock is held, rather than waiting', async () => {
    const h = new Harness();
    writeFileSync(join(h.jobsDir, '.drain.lock'), `${JSON.stringify({ pid: 4242, pidStart: 'live' })}\n`);
    h.live = { startTime: (pid) => (pid === 4242 ? 'live' : null) };
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'locked' });
  });
});

// ── Running the model stages ──────────────────────────────────────────────

describe('the model stages', () => {
  it('advances build to review, charges the time and records the artifact', async () => {
    const h = new Harness();
    h.write(job());
    const outcome = await drainOnce(h.ctx());
    expect(outcome).toMatchObject({ action: 'ran', detail: 'build ok' });
    const after = h.read(34);
    expect(after.stage).toBe('review');
    expect(after.stageState).toBe('ready');
    expect(after.spentMs).toBe(12 * MIN);
    expect(after.artifacts.build).toContain('artifacts/34/build.md');
    expect(after.attempts.build).toBeUndefined();
    expect(after.stageStartedAt).toBeUndefined();
    expect(h.spawns[0]).toMatchObject({ agent: 'delegate-executor', cwd: job().worktree });
    expect(h.branchSha).toBe('bbbbbbb');
    expect(h.spawns[0]?.timeoutMs).toBe(50 * MIN);
  });

  it('requeues a failed build silently, counting one attempt', async () => {
    const h = new Harness();
    h.write(job());
    h.stageOutcome = { code: 1, timedOut: false };
    h.stageDurationMs = 20 * MIN;
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'build failed' });
    const after = h.read(34);
    expect(after).toMatchObject({ stage: 'build', stageState: 'ready' });
    expect(after.attempts.build).toBe(1);
    expect(after.spentMs).toBe(20 * MIN);
    expect(h.pages).toEqual([]);
  });

  it('charges a timed-out attempt its whole budget', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review', stageState: 'ready' }));
    h.stageOutcome = { code: null, timedOut: true };
    h.stageDurationMs = 20 * MIN;
    await drainOnce(h.ctx());
    const after = h.read(34);
    expect(after.attempts.review).toBe(1);
    expect(after.spentMs).toBe(20 * MIN);
    expect(after.history.at(-1)).toMatchObject({ result: 'timeout', exit: null });
  });

  it('fails a review that commits, not just one that edits', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: clean' };
    // The fake stage only moves the branch for build/fix, so move it by hand mid-review.
    h.afterSpawn = () => {
      h.branchSha = 'ccccccc';
    };
    await drainOnce(h.ctx());
    const after = h.read(34);
    expect(after.stage).toBe('review');
    expect(after.attempts.review).toBe(1);
    expect(h.logs.join('\n')).toContain('not read-only');
  });

  it('does not blame the reviewer for dirt the builder left behind', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: clean' };
    h.dirtyWorktree = '?? coverage/\n';
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran' });
    expect(h.read(34).stage).toBe('deliver');
    expect(h.logs.join('\n')).toContain('already dirty before the review');
  });

  it('says when a build leaves uncommitted files behind', async () => {
    const h = new Harness();
    h.write(job());
    h.afterSpawn = () => {
      h.dirtyWorktree = '?? coverage/\n';
    };
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran' });
    expect(h.read(34).stage).toBe('review');
    expect(h.logs.join('\n')).toContain('left uncommitted files behind');
  });

  it('fails a stage whose child reported nothing', async () => {
    const h = new Harness();
    h.write(job());
    h.reports = {};
    expect((await drainOnce(h.ctx()))?.detail).toBe('build failed');
    expect(h.read(34).attempts.build).toBe(1);
  });

  it('fails a build that committed nothing', async () => {
    const h = new Harness();
    h.stageCommits = false;
    h.write(job());
    await drainOnce(h.ctx());
    expect(h.read(34).attempts.build).toBe(1);
    expect(h.logs.join('\n')).toContain('committed nothing');
  });

  it('fails a review that left the worktree dirty, because read-only is code-enforced', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: clean' };
    h.afterSpawn = () => {
      h.dirtyWorktree = ' M src/engine/WorldEngine.ts\n';
    };
    await drainOnce(h.ctx());
    const after = h.read(34);
    expect(after.stage).toBe('review');
    expect(after.attempts.review).toBe(1);
    expect(h.logs.join('\n')).toContain('not read-only');
  });

  it('skips the fix stage when the review reports no findings', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: clean\n\nNothing to report.' };
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran' });
    const after = h.read(34);
    expect(after.stage).toBe('deliver');
    expect(after.history.map((entry) => `${entry.stage}:${entry.result}`)).toEqual(['review:ok', 'fix:skipped']);
    expect(h.spawns.map((run) => run.stage)).toEqual(['review']);
  });

  it('runs the fixer on the findings file when the review found something', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: findings\n\n- src/a.ts:1 does not compile' };
    await drainOnce(h.ctx());
    const after = h.read(34);
    expect(after.stage).toBe('fix');
    expect(after.artifacts.review).toContain('review.md');
  });

  it('accepts a fixer that reports nothing to change, without a commit', async () => {
    const h = new Harness();
    h.stageCommits = false;
    h.write(job({ stage: 'fix' }));
    h.reports = { fix: 'VERDICT: nochange\n\nAlready correct.' };
    await drainOnce(h.ctx());
    expect(h.read(34).stage).toBe('deliver');
  });

  it('points the fixer at the review findings file', async () => {
    const h = new Harness();
    h.write(job({ stage: 'fix' }));
    await drainOnce(h.ctx());
    expect(h.spawns[0]?.agent).toBe('delegate-fixer');
    expect(h.spawns[0]?.task).toContain(join(String(34), 'review.md'));
  });

  it('titles the review task with the verdict contract', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    await drainOnce(h.ctx());
    expect(h.spawns[0]?.task).toContain('VERDICT: clean');
    expect(h.spawns[0]?.task).toContain('read-only');
  });
});

// ── Blocking, paging, retrying ────────────────────────────────────────────

describe('the failure policy', () => {
  it('blocks and pages on the second failure, with the board and a comment', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ attempts: { build: 1 } }));
    h.stageOutcome = { code: 1, timedOut: false };
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'build failed' });
    expect(h.read(34).attempts.build).toBe(2);

    // The next tick is the one that reads the guard.
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    const after = h.read(34);
    expect(after.stageState).toBe('blocked');
    expect(h.called('gh', 'project item-edit')).toBe(true);
    expect(h.called('gh', 'issue comment 34')).toBe(true);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('blocked');
  });

  it('blocks a spent job before another model stage, without running anything', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'fix', spentMs: JOB_CAP_MS, attempts: {} }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    expect(h.spawns).toEqual([]);
    expect(h.read(34).stageState).toBe('blocked');
  });

  it('still delivers a job that spent its whole budget getting through the model stages', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'deliver', spentMs: JOB_CAP_MS, attempts: {} }));
    h.when('gh', ['pr', 'create'], ok('https://github.com/WernerVdM97/daily-pixel/pull/117\n'));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'deliver' });
    expect(h.read(34)).toMatchObject({ pr: 117, stage: 'reconcile' });
  });

  it('pages again when the block tick dies before the page goes out', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stageState: 'blocked' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    expect(h.pages).toHaveLength(1);
    expect(h.read(34).pagedAt).toBeDefined();
    // Paged: a later tick leaves it alone.
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'idle' });
    expect(h.pages).toHaveLength(1);
  });

  it('keeps the page even when the board comment fails, and never claims it paged twice', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.when('gh', ['issue comment'], { code: 1, stdout: '', stderr: 'HTTP 502' });
    h.write(job({ attempts: { build: 2 } }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    expect(h.pages).toHaveLength(1);
    expect(h.read(34).pagedAt).toBeDefined();
    expect(h.logs.join('\n')).toContain('block comment failed');
  });

  it('retries a failed `done` instead of blocking an item that is already merged', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"MERGED","mergedAt":"2026-09-11T13:00:00Z"}'));
    h.when('git', ['worktree remove'], { code: 1, stdout: '', stderr: 'locked' });
    h.board = [item({ number: 34, status: 'In Review' })];
    h.write(job({ stage: 'reconcile', pr: 117 }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'done failed' });
    expect(h.read(34)).toMatchObject({ stage: 'done', stageState: 'ready', attempts: { done: 1 } });
    // Two failures are a pattern, but blocking is for stages that still have work in them.
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran' });
    expect(h.read(34).stageState).toBe('ready');
    expect(h.pages).toEqual([]);
  });

  it('lets retry clear the block, zero the attempts and refresh the budget', () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'Blocked' })];
    h.write(job({ stage: 'fix', stageState: 'blocked', attempts: { build: 2, fix: 1 }, spentMs: JOB_CAP_MS }));
    const res = retryPass(h.ctx(), 34);
    expect(res.ok).toBe(true);
    const after = h.read(34);
    expect(after).toMatchObject({ stage: 'fix', stageState: 'ready', attempts: {}, spentMs: 0 });
    expect(after.history.at(-1)?.result).toBe('retried');
    expect(h.called('gh', 'issue comment 34')).toBe(true);
    // The one board write retry makes: Blocked back to In Progress.
    expect(h.calls.some((call) => call.cmd === 'gh' && call.args.includes('bfbe5d7d'))).toBe(true);
  });

  it('reports rather than waits when retry finds the drain lock held', () => {
    const h = new Harness();
    h.write(job({ stageState: 'blocked' }));
    writeFileSync(join(h.jobsDir, '.drain.lock'), `${JSON.stringify({ pid: 4242, pidStart: 'live' })}\n`);
    h.live = { startTime: (pid) => (pid === 4242 ? 'live' : null) };
    expect(retryPass(h.ctx(), 34).ok).toBe(false);
  });
});

// ── Delivery and the merge ────────────────────────────────────────────────

describe('deliver is code', () => {
  it('pushes the branch and opens a PR to dev with Closes', async () => {
    const h = new Harness();
    h.when('git', ['log', '--no-merges'], ok('- feat(#34): emoji labels\n- fix(#34): frame\n'));
    h.when('gh', ['pr', 'create'], ok('https://github.com/WernerVdM97/daily-pixel/pull/117\n'));
    const commands = deliverCommands(h.ctx(), job({ stage: 'deliver' }));
    expect(commands[0]).toMatchObject({ cmd: 'git', args: ['push', '-u', 'origin', 'feat/34-last-stand'] });
    expect(commands[1]?.args).toEqual([
      'pr',
      'create',
      '--base',
      'dev',
      '--head',
      'feat/34-last-stand',
      '--title',
      'Last stand buttons/captions',
      '--body-file',
      '-',
    ]);
    expect(commands[1]?.input).toContain('Closes #34');
    expect(commands[1]?.input).toContain('- feat(#34): emoji labels');

    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'deliver' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'deliver' });
    const after = h.read(34);
    expect(after.pr).toBe(117);
    expect(after.stage).toBe('reconcile');
    expect(h.called('gh', 'project item-edit')).toBe(true);
    expect(h.logs.join('\n')).toContain('PR opened for review');
  });

  it('reuses the branch\'s open PR instead of creating a second one', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'list'], ok('[{"number":117,"url":"https://example.test/pull/117"}]'));
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'deliver' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'deliver' });
    expect(h.called('gh', 'pr create')).toBe(false);
    expect(h.read(34)).toMatchObject({ pr: 117, stage: 'reconcile' });
  });

  it('delivers even when the board write after the PR fails', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'create'], ok('https://github.com/WernerVdM97/daily-pixel/pull/117\n'));
    h.when('gh', ['issue comment'], { code: 1, stdout: '', stderr: 'HTTP 502' });
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'deliver' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', detail: 'deliver' });
    expect(h.read(34)).toMatchObject({ pr: 117, stage: 'reconcile' });
    expect(h.logs.join('\n')).toContain('PR-link comment failed');
  });

  it('never composes the PR body from an agent report', () => {
    const h = new Harness();
    h.when('git', ['log', '--no-merges'], ok(''));
    const body = deliverCommands(h.ctx(), job({ stage: 'deliver' }))[1]?.input ?? '';
    expect(body).toContain('no agent ran this step');
    expect(body).toContain('(no commit subjects found)');
  });
});

describe('reconcile', () => {
  it('leaves the job waiting on an open PR, charged nothing', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"OPEN","mergedAt":null}'));
    h.write(job({ stage: 'reconcile', pr: 117, spentMs: 91 * MIN }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'idle' });
    const after = h.read(34);
    expect(after.stageState).toBe('waiting');
    expect(after.spentMs).toBe(91 * MIN);
    expect(after.attempts).toEqual({});
    expect(after.waitingSince).toBeDefined();
  });

  it('survives many ticks without reaching the attempt or budget guards', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"OPEN","mergedAt":null}'));
    h.write(job({ stage: 'reconcile', pr: 117, spentMs: 99 * MIN }));
    for (let tick = 0; tick < 6; tick += 1) {
      expect(await drainOnce(h.ctx())).toMatchObject({ action: 'idle' });
    }
    const after = h.read(34);
    expect(after).toMatchObject({ stageState: 'waiting', spentMs: 99 * MIN, attempts: {} });
    expect(after.history).toEqual([]);
    expect(h.called('gh', 'issue comment 34')).toBe(false);
  });

  it('does not let a waiting job starve a build that has work in it', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"OPEN","mergedAt":null}'));
    h.write(
      job({
        item: 10,
        stage: 'reconcile',
        stageState: 'waiting',
        waitingSince: '2026-09-10T10:00:00.000Z',
        pr: 100,
        startedAt: '2026-09-10T10:00:00.000Z',
      }),
    );
    h.write(job({ item: 34, stage: 'build', startedAt: '2026-09-11T10:00:00.000Z' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'ran', item: 34, detail: 'build ok' });
    expect(h.read(10).stageState).toBe('waiting');
  });

  it('sets Done, closes the issue and archives the job on a merge', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"MERGED","mergedAt":"2026-09-11T13:00:00Z"}'));
    h.board = [item({ number: 34, status: 'In Review' })];
    h.write(job({ stage: 'reconcile', pr: 117, spentMs: 60 * MIN }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'finished', item: 34 });
    expect(h.has(34)).toBe(false);
    const archived = h.archived(34);
    expect(archived.stage).toBe('done');
    expect(archived.pr).toBe(117);
    expect(h.called('gh', 'issue close 34')).toBe(true);
    expect(h.called('git', 'worktree remove --force')).toBe(true);
    expect(h.logs.join('\n')).toContain('branch feat/34-last-stand kept');
  });

  it('finishes a merged job in one tick on the waiting path too', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"MERGED","mergedAt":"2026-09-11T13:00:00Z"}'));
    h.board = [item({ number: 34, status: 'In Review' })];
    h.write(
      job({ stage: 'reconcile', stageState: 'waiting', waitingSince: '2026-09-09T00:00:00.000Z', pr: 117 }),
    );
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'finished' });
    expect(h.has(34)).toBe(false);
    expect(h.archived(34).stage).toBe('done');
    expect(h.called('git', 'worktree remove --force')).toBe(true);
  });

  it('blocks a PR that was closed without merging', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], ok('{"state":"CLOSED","mergedAt":null}'));
    h.board = [item({ number: 34, status: 'In Review' })];
    h.write(job({ stage: 'reconcile', stageState: 'waiting', pr: 117, waitingSince: '2026-09-01T00:00:00.000Z' }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    expect(h.read(34).stageState).toBe('blocked');
    expect(h.pages[0]).toContain('closed without merging');
  });

  it('does not charge a failed check against a waiting job', async () => {
    const h = new Harness();
    h.when('gh', ['pr', 'view'], { code: 1, stdout: '', stderr: 'boom' });
    h.write(job({ stage: 'reconcile', stageState: 'waiting', pr: 117 }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'idle' });
    expect(h.read(34).attempts).toEqual({});
  });
});

// ── start ─────────────────────────────────────────────────────────────────

describe('start', () => {
  it('claims an approved item, cuts the worktree and leaves it at build', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'Approved', title: 'Last stand buttons' })];
    h.when('git', ['branch', '-a'], ok('dev\nmain\n'));
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'started', item: 34, branch: 'feat/34-last-stand-buttons' });
    expect(h.called('git', 'worktree add -b feat/34-last-stand-buttons')).toBe(true);
    expect(h.called('gh', 'issue comment 34')).toBe(true);
    expect(h.calls.some((call) => call.cmd === 'gh' && call.args.includes('bfbe5d7d'))).toBe(true);
    expect(h.read(34)).toMatchObject({
      stage: 'build',
      stageState: 'ready',
      branch: 'feat/34-last-stand-buttons',
      baseRef: 'dev',
      spentMs: 0,
      attempts: {},
      pr: null,
    });
  });

  it('adopts an orphan at review, merges the base ref in, and charges it nothing', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.when('gh', ['issue view 34'], ok('{"comments":[{"author":{"login":"agent97eth"},"body":"factory: claimed (branch feat/34-last-stand)"}]}'));
    h.when('git', ['branch', '-a'], ok('dev\nfeat/34-last-stand\n'));
    h.when('git', ['rev-list', '--count'], ok('1\n'));
    h.when('git', ['rev-parse', '--short'], ok('31eb9e3\n'));
    h.when('git', ['rev-parse', 'origin/dev'], ok('d3f557b\n'));
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'adopted', item: 34, branch: 'feat/34-last-stand' });
    const adopted = h.read(34);
    expect(adopted).toMatchObject({ stage: 'review', spentMs: 0, attempts: {} });
    expect(adopted.adoptedFrom).toEqual({ branch: 'feat/34-last-stand', commit: '31eb9e3', mergedDev: 'd3f557b' });
    expect(h.called('git', 'worktree add')).toBe(true);
    // Stages are discovered from the worktree, so the adopted tree has to be current.
    expect(h.called('git', 'merge --no-edit origin/dev')).toBe(true);
  });

  it('opens no job when the base ref will not merge into the orphan, and says so', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.when('gh', ['issue view 34'], ok('{"comments":[{"author":{"login":"agent97eth"},"body":"factory: claimed (branch feat/34-last-stand)"}]}'));
    h.when('git', ['branch', '-a'], ok('dev\nfeat/34-last-stand\n'));
    h.when('git', ['rev-list', '--count'], ok('1\n'));
    h.when('git', ['rev-parse', '--short'], ok('31eb9e3\n'));
    h.when('git', ['merge --no-edit origin/dev'], { code: 1, stdout: '', stderr: 'CONFLICT' });
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'conflict', item: 34 });
    expect(h.called('git', 'merge --abort')).toBe(true);
    expect(h.called('gh', 'issue comment 34')).toBe(true);
    expect(h.has(34)).toBe(false);
    // Nothing was claimed on the board either, so the item stays for the owner.
    expect(h.calls.some((call) => call.cmd === 'gh' && call.args.includes('bfbe5d7d'))).toBe(false);
  });

  it('reports a worktree it cannot create instead of throwing, and claims nothing', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'Approved' })];
    h.when('git', ['branch', '-a'], ok('dev\n'));
    h.when('git', ['worktree add'], { code: 1, stdout: '', stderr: "fatal: 'feat/34-last-stand-buttons' is already checked out" });
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'stuck', item: 34 });
    expect(h.has(34)).toBe(false);
    expect(h.called('gh', 'issue comment')).toBe(false);
  });

  it('starts nothing when no item passes the gate', async () => {
    const h = new Harness();
    h.board = [item({ number: 5, status: 'Inbox' }), item({ number: 6, status: 'Triaged' })];
    h.when('git', ['branch', '-a'], ok('dev\n'));
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'nothing' });
    expect(h.has(34)).toBe(false);
  });

  it('writes nothing at all in a dry run', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'Approved' })];
    h.when('git', ['branch', '-a'], ok('dev\n'));
    const { startPass } = await import('../../scripts/factory-jobs.js');
    await startPass(h.ctx({ dryRun: true }));
    expect(h.called('git', 'worktree add')).toBe(false);
    expect(h.called('gh', 'issue comment')).toBe(false);
    expect(h.has(34)).toBe(false);
  });
});

// ── Housekeeping: a fresh base, no stale branches ─────────────────────────

describe('housekeeping', () => {
  it('fetches, fast-forwards the checked-out dev, and prunes merged branches', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.devBehind = 2;
    h.branches = ['dev', 'main', 'feat/merged', 'feat/34-last-stand'];
    h.mergedPrs = [{ branch: 'feat/merged', oid: h.branchSha, number: 5 }];
    const out = housekeeping(h.ctx());
    expect(h.called('git', 'fetch origin --prune')).toBe(true);
    expect(h.called('git', 'merge --ff-only origin/dev')).toBe(true);
    expect(out.devRef).toBe('advanced');
    expect(out.devRefBehind).toBe(2);
    expect(out.deleted).toContainEqual({
      branch: 'feat/merged',
      commit: 'aaaaaaa',
      reason: 'PR #5 merged at this exact commit',
    });
    expect(out.kept).toContainEqual({ branch: 'dev', commit: '', reason: 'protected' });
    expect(out.kept).toContainEqual({ branch: 'main', commit: '', reason: 'protected' });
    expect(out.kept).toContainEqual({ branch: 'feat/34-last-stand', commit: 'aaaaaaa', reason: 'not merged' });
  });

  it('keeps a branch whose commits moved past what its merged PR saw', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'feat/34-last-stand'];
    h.mergedPrs = [{ branch: 'feat/34-last-stand', oid: 'aaaaaaa', number: 107 }];
    h.tips = { 'feat/34-last-stand': 'ccccccc' };
    const out = housekeeping(h.ctx());
    expect(out.deleted).toEqual([]);
    expect(h.called('git', 'branch')).toBe(false);
    expect(out.kept).toContainEqual({
      branch: 'feat/34-last-stand',
      commit: 'ccccccc',
      reason: "its tip differs from merged PR #107's head aaaaaaa",
    });
    expect(h.logs.join('\n')).toBe('');
  });

  it('tries the safe delete first, and forces it only with the tip proof', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'feat/squashed'];
    h.tips = { 'feat/squashed': 'bbbbbbb' };
    h.mergedPrs = [{ branch: 'feat/squashed', oid: 'bbbbbbb', number: 9 }];
    const out = housekeeping(h.ctx());
    expect(out.deleted).toEqual([
      { branch: 'feat/squashed', commit: 'bbbbbbb', reason: 'PR #9 merged at this exact commit' },
    ]);
    expect(h.called('git', 'branch -d feat/squashed')).toBe(true);
    expect(h.called('git', 'branch -D feat/squashed')).toBe(true);
    expect(h.logs.join('\n')).toContain('forcing');
  });

  it('asks gh about one branch when the bulk merged-PR page may be truncated', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.bulkTruncated = true;
    h.branches = ['dev', 'feat/squashed'];
    h.mergedPrs = [{ branch: 'feat/squashed', oid: h.branchSha, number: 9 }];
    const out = housekeeping(h.ctx());
    expect(out.deleted.map((entry) => entry.branch)).toEqual(['feat/squashed']);
    expect(h.calls.filter((call) => call.cmd === 'gh' && call.args.includes('--head')).length).toBe(1);
  });

  it('does not ask per branch when the bulk page came back whole', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'feat/unknown'];
    h.mergedPrs = [{ branch: 'someone/else', oid: h.branchSha, number: 9 }];
    expect(housekeeping(h.ctx()).deleted).toEqual([]);
    expect(h.calls.filter((call) => call.cmd === 'gh' && call.args.includes('--head')).length).toBe(0);
  });

  it('deletes a squashed branch, which is not an ancestor of dev', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'docs/squashed'];
    h.mergedPrs = [{ branch: 'docs/squashed', oid: h.branchSha, number: 108 }];
    h.ancestors = new Set();
    const out = housekeeping(h.ctx());
    expect(out.deleted.map((entry) => entry.branch)).toEqual(['docs/squashed']);
  });

  it('deletes a branch that is wholly contained in the tracked ref even with no PR', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'chore/merged-by-hand'];
    h.ancestors = new Set(['chore/merged-by-hand']);
    const out = housekeeping(h.ctx());
    expect(out.deleted).toEqual([
      { branch: 'chore/merged-by-hand', commit: 'aaaaaaa', reason: 'contained in origin/dev' },
    ]);
    // Ancestry is proof enough: no merged PR, no forcing.
    expect(h.called('git', 'branch -D')).toBe(false);
  });

  it('never deletes a branch a live job owns, or one checked out elsewhere', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.branches = ['dev', 'feat/34-last-stand', 'feat/in-a-worktree'];
    h.mergedPrs = [
      { branch: 'feat/34-last-stand', oid: h.branchSha, number: 1 },
      { branch: 'feat/in-a-worktree', oid: h.branchSha, number: 2 },
    ];
    h.worktreeBranches = ['feat/in-a-worktree'];
    h.write(job({ branch: 'feat/34-last-stand' }));
    const out = housekeeping(h.ctx());
    expect(out.deleted).toEqual([]);
    expect(out.kept).toContainEqual({ branch: 'feat/34-last-stand', commit: '', reason: 'a live job owns it' });
    expect(out.kept).toContainEqual({
      branch: 'feat/in-a-worktree',
      commit: '',
      reason: 'checked out in a worktree',
    });
  });

  it('leaves dev alone rather than moving it under a dirty checkout', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.devBehind = 1;
    h.dirtyWorktree = ' M src/a.ts\n';
    const out = housekeeping(h.ctx());
    expect(out.devRef).toBe('behind-but-unsafe');
    expect(h.called('git', 'merge --ff-only')).toBe(false);
    expect(h.logs.join('\n')).toContain('dirty');
  });

  it('moves the local dev ref without touching the tree when dev is not checked out', () => {
    const h = new Harness();
    h.currentBranch = 'feat/elsewhere';
    h.devBehind = 3;
    const out = housekeeping(h.ctx());
    expect(out.devRef).toBe('advanced');
    expect(h.called('git', 'fetch origin dev:dev')).toBe(true);
    expect(h.called('git', 'merge --ff-only')).toBe(false);
  });

  it('reports a base ref it cannot fast-forward instead of forcing it', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.devBehind = 4;
    h.when('git', ['merge', '--ff-only'], { code: 1, stdout: '', stderr: 'not possible to fast-forward' });
    expect(housekeeping(h.ctx()).devRef).toBe('behind-but-unsafe');
  });

  it('prunes nothing when the fetch fails, rather than acting on stale refs', () => {
    const h = new Harness();
    h.branches = ['dev', 'feat/merged'];
    h.mergedPrs = [{ branch: 'feat/merged', oid: h.branchSha, number: 5 }];
    h.when('git', ['fetch', 'origin', '--prune'], { code: 1, stdout: '', stderr: 'no network' });
    const out = housekeeping(h.ctx());
    expect(out.fetched).toBe(false);
    expect(out.deleted).toEqual([]);
    expect(h.called('git', 'branch -D')).toBe(false);
    expect(h.called('gh', 'pr list')).toBe(false);
  });

  it('moves no ref and deletes no branch in a dry run', () => {
    const h = new Harness();
    h.currentBranch = 'dev';
    h.devBehind = 1;
    h.branches = ['dev', 'feat/merged'];
    h.mergedPrs = [{ branch: 'feat/merged', oid: h.branchSha, number: 5 }];
    const out = housekeeping(h.ctx({ dryRun: true }));
    expect(h.called('git', 'fetch')).toBe(false);
    expect(h.called('git', 'merge --ff-only')).toBe(false);
    expect(h.called('git', 'branch -D')).toBe(false);
    // Reported as if it had run, so the operator can see what the tick would do.
    expect(out).toMatchObject({
      fetched: true,
      devRef: 'behind-but-unsafe',
      deleted: [{ branch: 'feat/merged', commit: 'aaaaaaa', reason: 'PR #5 merged at this exact commit' }],
    });
  });
});

// ── Read-only commands, dry run, plumbing ─────────────────────────────────

describe('the ledger read-outs', () => {
  it('lists live jobs and reports orphans and long waits', () => {
    const h = new Harness();
    h.write(job({ item: 34, stage: 'reconcile', stageState: 'waiting', pr: 117, waitingSince: '2026-09-01T00:00:00.000Z' }));
    h.write(job({ item: 40, stageState: 'running', claim: { pid: 4242, pidStart: 'gone' } }));
    const list = listJobs(h.ctx());
    expect(list).toContain('#34');
    expect(list).toContain('#40');
    const stale = staleReport(h.ctx());
    expect(stale).toContain('#40');
    expect(stale).toContain('#34');
    expect(stale).toContain('has been open 11 days');
  });

  it('ignores an unreadable record instead of crashing the tick', () => {
    const h = new Harness();
    writeFileSync(join(h.jobsDir, '99.json'), '{ not json');
    expect(loadJobs(h.jobsDir)).toEqual([]);
  });

  it('parses a verdict line, and defaults to findings when there is none', () => {
    expect(parseVerdict('VERDICT: clean\n\nnothing')).toBe('clean');
    expect(parseVerdict('**VERDICT: findings**')).toBe('findings');
    expect(parseVerdict('VERDICT: ok')).toBe('ok');
    expect(parseVerdict('VERDICT: nochange')).toBe('nochange');
    expect(parseVerdict('I found three things')).toBe('findings');
  });

  it('names the branch and the worktree the way the repo does', () => {
    expect(branchFor(34, 'Last stand buttons/captions: emojis + combat scene frame')).toBe(
      'feat/34-last-stand-buttons-captions-emojis-combat-scene',
    );
    expect(worktreePathFor('/home/werner/projects/worktrees/daily-pixel', 'feat/34-x')).toBe(
      '/home/werner/projects/worktrees/daily-pixel/feat-34-x',
    );
  });

  it('resolves the canonical checkout, never a linked worktree of it', () => {
    const exec = (() => ok('/home/werner/projects/daily-pixel/.git\n')) as Exec;
    expect(resolveRepoRoot({ env: {}, exec })).toBe('/home/werner/projects/daily-pixel');
    expect(resolveRepoRoot({ env: { FACTORY_PROJECT_DIR: '/tmp/scratch' }, exec })).toBe('/tmp/scratch');
  });

  it('decides a dry run without spawning or writing', async () => {
    const h = new Harness();
    h.write(job());
    const before = readFileSync(join(h.jobsDir, '34.json'), 'utf8');
    const ctx = h.ctx({ dryRun: true });
    expect(await drainOnce(ctx)).toMatchObject({ action: 'ran', detail: 'dry-run: build' });
    expect(h.spawns).toEqual([]);
    expect(readFileSync(join(h.jobsDir, '34.json'), 'utf8')).toBe(before);
    expect(h.logs.join('\n')).toContain('would spawn delegate-executor');
  });

  it('never kills a process or removes a worktree in a dry run', async () => {
    const h = new Harness();
    h.live = { startTime: (pid) => (pid === 4242 ? 'x' : null) };
    h.write(
      job({
        stageState: 'running',
        claim: { pid: 4242, pidStart: 'x' },
        stageStartedAt: '2026-09-11T11:30:00.000Z',
      }),
    );
    expect(await drainOnce(h.ctx({ dryRun: true }))).toMatchObject({ action: 'reaped' });
    expect(h.killed).toEqual([]);
    expect(h.read(34).stageState).toBe('running');

    const merged = new Harness();
    merged.when('gh', ['pr', 'view'], ok('{"state":"MERGED","mergedAt":"2026-09-11T13:00:00Z"}'));
    merged.board = [item({ number: 34, status: 'In Review' })];
    merged.write(job({ stage: 'reconcile', pr: 117 }));
    expect(await drainOnce(merged.ctx({ dryRun: true }))).toMatchObject({ action: 'finished' });
    expect(merged.called('git', 'worktree remove')).toBe(false);
    expect(merged.has(34)).toBe(true);
  });
});
