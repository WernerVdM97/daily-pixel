import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_LABELS,
  BASE_REF,
  type BoardItem,
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
  /** Successive `git rev-parse HEAD` answers, so a stage can be seen committing. */
  headQueue: string[] = ['aaaaaaa', 'bbbbbbb'];

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
      const report = this.reports[run.stage];
      if (report !== undefined) {
        const path = join(this.jobsDir, 'artifacts', String(run.item), `${run.stage}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, report);
      }
      return { code: this.stageOutcome.code, timedOut: this.stageOutcome.timedOut, stdout: '', stderr: '' };
    },
    killGroup: (pid) => this.killed.push(pid),
    log: (msg) => this.logs.push(msg),
    page: (title, body) => this.pages.push(`${title}\n${body}`),
  });

  private execSync(cmd: string, args: string[]): ExecResult {
    this.calls.push({ cmd, args });
    if (cmd === 'gh' && args.join(' ').startsWith('project item-list')) {
      return ok(JSON.stringify({ items: this.board.map(toRawItem) }));
    }
    if (cmd === 'git' && args.join(' ') === 'rev-parse HEAD') return ok(`${this.headQueue.shift() ?? 'zzzzzzz'}\n`);
    if (cmd === 'git' && args.join(' ').startsWith('status --porcelain')) return ok(this.dirtyWorktree);
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
    expect(decide(job({ stageState: 'blocked' }), live)).toMatchObject({ kind: 'skip' });
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

  it('fails a stage whose child reported nothing', async () => {
    const h = new Harness();
    h.write(job());
    h.reports = {};
    expect((await drainOnce(h.ctx()))?.detail).toBe('build failed');
    expect(h.read(34).attempts.build).toBe(1);
  });

  it('fails a build that committed nothing', async () => {
    const h = new Harness();
    h.headQueue = ['aaaaaaa', 'aaaaaaa'];
    h.write(job());
    await drainOnce(h.ctx());
    expect(h.read(34).attempts.build).toBe(1);
    expect(h.logs.join('\n')).toContain('committed nothing');
  });

  it('fails a review that left the worktree dirty, because read-only is code-enforced', async () => {
    const h = new Harness();
    h.write(job({ stage: 'review' }));
    h.reports = { review: 'VERDICT: clean' };
    h.dirtyWorktree = ' M src/engine/WorldEngine.ts\n';
    await drainOnce(h.ctx());
    const after = h.read(34);
    expect(after.stage).toBe('review');
    expect(after.attempts.review).toBe(1);
    expect(h.logs.join('\n')).toContain('left the worktree dirty');
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
    h.headQueue = ['aaaaaaa', 'aaaaaaa'];
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

  it('blocks a job that spent the cumulative cap, without running anything', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.write(job({ stage: 'fix', spentMs: JOB_CAP_MS, attempts: {} }));
    expect(await drainOnce(h.ctx())).toMatchObject({ action: 'blocked' });
    expect(h.spawns).toEqual([]);
    expect(h.read(34).stageState).toBe('blocked');
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
    h.when('git', ['rev-parse', 'dev'], ok('d3f557b\n'));
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'adopted', item: 34, branch: 'feat/34-last-stand' });
    const adopted = h.read(34);
    expect(adopted).toMatchObject({ stage: 'review', spentMs: 0, attempts: {} });
    expect(adopted.adoptedFrom).toEqual({ branch: 'feat/34-last-stand', commit: '31eb9e3', mergedDev: 'd3f557b' });
    expect(h.called('git', 'worktree add')).toBe(true);
    // Stages are discovered from the worktree, so the adopted tree has to be current.
    expect(h.called('git', 'merge --no-edit dev')).toBe(true);
  });

  it('opens no job when the base ref will not merge into the orphan, and says so', async () => {
    const h = new Harness();
    h.board = [item({ number: 34, status: 'In Progress' })];
    h.when('gh', ['issue view 34'], ok('{"comments":[{"author":{"login":"agent97eth"},"body":"factory: claimed (branch feat/34-last-stand)"}]}'));
    h.when('git', ['branch', '-a'], ok('dev\nfeat/34-last-stand\n'));
    h.when('git', ['rev-list', '--count'], ok('1\n'));
    h.when('git', ['rev-parse', '--short'], ok('31eb9e3\n'));
    h.when('git', ['merge --no-edit dev'], { code: 1, stdout: '', stderr: 'CONFLICT' });
    const { startPass } = await import('../../scripts/factory-jobs.js');
    expect(await startPass(h.ctx())).toMatchObject({ action: 'conflict', item: 34 });
    expect(h.called('git', 'merge --abort')).toBe(true);
    expect(h.called('gh', 'issue comment 34')).toBe(true);
    expect(h.has(34)).toBe(false);
    // Nothing was claimed on the board either, so the item stays for the owner.
    expect(h.calls.some((call) => call.cmd === 'gh' && call.args.includes('bfbe5d7d'))).toBe(false);
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
});
