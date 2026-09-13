import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentOf,
  isProbeExit,
  readLedger,
  unprocessedOwnerAnswer,
} from '../../scripts/factory-friction.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');

describe('agentOf', () => {
  it('extracts the agent from a subagent session name', () => {
    expect(agentOf('subagent-factory-triage-e0b801ef-9f9c-43f7-8b9e-3d552a5aff24-1', '')).toBe('factory-triage');
    expect(agentOf('subagent-delegate-reviewer-e6954b3b-70fd-49e7-b078-88e5363b6110-2', '')).toBe('delegate-reviewer');
  });

  it('labels a schedule.run-due launcher session as scheduler-run', () => {
    expect(agentOf(null, "Call subagent({action:'schedule.run-due'}) exactly once.")).toBe('scheduler-run');
  });

  it('falls back to interactive for an owner session', () => {
    expect(agentOf(null, 'how is the dark factory performing?')).toBe('interactive');
  });

  it('prefers the subagent name over the brief, since a fork replays both', () => {
    expect(agentOf('subagent-factory-sweeper-00000000-0000-0000-0000-000000000000-1', "subagent({action:'schedule.run-due'})")).toBe('factory-sweeper');
  });

  it('does not mistake a non-subagent session_info name for an agent', () => {
    expect(agentOf('my custom session name', '')).toBe('interactive');
  });
});

describe('isProbeExit', () => {
  it('classifies grep/diff/cmp exits as probes: the nonzero exit is the check itself', () => {
    expect(isProbeExit('bash', 'grep -q "auto:docs" .pi/agents/factory-triage.md', '(no output)')).toBe(true);
    expect(isProbeExit('bash', 'diff -q a.md b.md', 'Files a.md and b.md differ')).toBe(true);
  });

  it('classifies negations, test/[ existence checks and git existence probes', () => {
    expect(isProbeExit('bash', '! gh pr view 12', 'not found')).toBe(true);
    expect(isProbeExit('bash', 'test -e .pi/factory/focus.json', 'not found')).toBe(true);
    expect(isProbeExit('bash', '[ -d docs/engine ]', 'not found')).toBe(true);
    expect(isProbeExit('bash', 'git rev-parse --verify refs/heads/dev', 'fatal:')).toBe(true);
  });

  it('classifies ls on an absent path as a probe, the 2026-09-12 survey case', () => {
    expect(isProbeExit('bash', 'ls .claude/skills/', "ls: cannot access '.claude/skills/': No such file or directory")).toBe(true);
  });

  it('strips a leading cd <dir> && wrapper before testing', () => {
    expect(isProbeExit('bash', 'cd /home/werner/projects/daily-pixel && grep -q auto:docs .pi/agents/x.md', '(no output)')).toBe(true);
    expect(
      isProbeExit('bash', 'cd /repo && ls .claude/skills/', "ls: cannot access '.claude/skills/': No such file or directory"),
    ).toBe(true);
  });

  it('keeps genuine failures out of the probe bucket', () => {
    expect(isProbeExit('bash', 'npm test', 'Traceback (most recent call last):')).toBe(false);
    expect(isProbeExit('bash', 'npx tsx scripts/factory-jobs.ts drain', 'exit 1')).toBe(false);
    expect(isProbeExit('bash', 'ls -la', 'Permission denied')).toBe(false); // not a missing path
    expect(isProbeExit('edit', 'grep -q x y', '')).toBe(false); // probes are a bash-only concept
  });
});

describe('unprocessedOwnerAnswer', () => {
  it('flags a Blocked item whose latest comment is the owner answer', () => {
    const comments = [
      { author: 'agent97eth', createdAt: '2026-09-10T21:51:49Z' },
      { author: 'WernerVdM97', createdAt: '2026-09-12T07:04:00Z' },
    ];
    const pending = unprocessedOwnerAnswer(comments, 'WernerVdM97', Date.parse('2026-09-12T13:00:00Z'));
    expect(pending).not.toBeNull();
    expect(pending!.ageHours).toBeCloseTo(6, 0);
    expect(pending!.missedPasses).toBe(false);
  });

  it('marks an answer that survived 24h as missed passes (two 12h triage passes)', () => {
    const comments = [{ author: 'WernerVdM97', createdAt: '2026-09-11T07:04:00Z' }];
    const pending = unprocessedOwnerAnswer(comments, 'WernerVdM97', NOW);
    expect(pending!.missedPasses).toBe(true);
  });

  it('returns null when a loop spoke last (the answer may already be digested)', () => {
    const comments = [
      { author: 'WernerVdM97', createdAt: '2026-09-12T07:04:00Z' },
      { author: 'agent97eth', createdAt: '2026-09-13T04:09:15Z' },
    ];
    expect(unprocessedOwnerAnswer(comments, 'WernerVdM97', NOW)).toBeNull();
  });

  it('matches the owner login case-insensitively and ignores empty comment tails', () => {
    expect(unprocessedOwnerAnswer([{ author: 'wernervdm97', createdAt: '2026-09-12T07:04:00Z' }], 'WernerVdM97', NOW)).not.toBeNull();
    expect(unprocessedOwnerAnswer([], 'WernerVdM97', NOW)).toBeNull();
  });
});

describe('readLedger', () => {
  const dirs: string[] = [];

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'factory-friction-test-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function jobRecord(item: number, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      item,
      title: `Job ${item}`,
      stage: 'done',
      spentMs: 400_000,
      updatedAt: new Date(NOW).toISOString(),
      history: [
        { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'ok' },
        { stage: 'review', endedAt: new Date(NOW).toISOString(), result: 'ok' },
        { stage: 'fix', endedAt: new Date(NOW).toISOString(), result: 'ok' },
      ],
      ...over,
    };
  }

  it('returns null when the ledger dir does not exist', () => {
    expect(readLedger(join(scratch(), 'nope'), 7 * 86_400_000)).toBeNull();
  });

  it('summarises first-try stages, retries and budget burn', () => {
    const dir = scratch();
    writeFileSync(join(dir, '92.json'), JSON.stringify(jobRecord(92, { pr: 116 })));
    const report = readLedger(dir, 7 * 86_400_000)!;
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].item).toBe(92);
    expect(report.jobs[0].pr).toBe(116);
    expect(report.jobs[0].done).toBe(true);
    expect(report.jobs[0].stages).toHaveLength(3);
    expect(report.firstTryOk).toBe(3);
    expect(report.retries).toBe(0);
    // Budget mirrors STAGES: 50 + 20 + 30 model minutes plus the three 1-minute code stages.
    expect(report.jobs[0].budgetMs).toBe(103 * 60_000);
    expect(report.jobs[0].burnPct).toBeCloseTo(400_000 / (103 * 60_000) * 100, 1);
  });

  it('counts a retried stage as not first-try ok and reports the retry', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, '93.json'),
      JSON.stringify(
        jobRecord(93, {
          history: [
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'failed' },
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'review', endedAt: new Date(NOW).toISOString(), result: 'ok' },
          ],
        }),
      ),
    );
    const report = readLedger(dir, 7 * 86_400_000)!;
    expect(report.firstTryOk).toBe(1);
    expect(report.retries).toBe(1);
    expect(report.jobs[0].stages.find((s) => s.stage === 'build')).toMatchObject({ attempts: 2, firstTryOk: false });
  });

  it('reads archive/ records and filters jobs outside the window', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', '91.json'), JSON.stringify(jobRecord(91)));
    const old = new Date(NOW - 30 * 86_400_000).toISOString();
    writeFileSync(
      join(dir, 'archive', '90.json'),
      JSON.stringify(
        jobRecord(90, {
          updatedAt: old,
          history: [
            { stage: 'build', endedAt: old, result: 'ok' },
            { stage: 'review', endedAt: old, result: 'ok' },
          ],
        }),
      ),
    );
    const report = readLedger(dir, 7 * 86_400_000)!;
    expect(report.jobs.map((j) => j.item)).toEqual([91]);
  });

  it('survives an unparseable record by noting it', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'broken.json'), '{not json');
    const report = readLedger(dir, 7 * 86_400_000)!;
    expect(report.jobs).toHaveLength(0);
    expect(report.notes.some((n) => n.includes('broken.json'))).toBe(true);
  });
});