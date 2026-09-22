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

  it('judges the segment that actually failed, not the first one', () => {
    // A chain exits with its last command's status, so a grep that matched in front of the
    // failure must not launder it as a probe (the observed `grep … | head; echo …; cmd` case).
    expect(
      isProbeExit('bash', 'grep -rn bulletin .pi/agents/ | head -5; echo "==="; npx tsx scripts/factory-jobs.ts drain', 'exit 1'),
    ).toBe(false);
    expect(isProbeExit('bash', 'cd /repo && grep -q x f && echo found; awk 1 g', 'awk: cannot open g')).toBe(false);
    // The probe as the last link is still a probe.
    expect(isProbeExit('bash', 'echo "---"; grep -q x f', '(no output)')).toBe(true);
    expect(isProbeExit('bash', 'cd /repo && test -e f', '')).toBe(true);
  });

  it('never calls a shell syntax error a probe', () => {
    expect(
      isProbeExit('bash', 'grep -rn "alias _=" ~/.zshrc | head; echo "==="', "/bin/bash: -c: line 1: unexpected EOF while looking for matching `\"'"),
    ).toBe(false);
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
    expect(readLedger(join(scratch(), 'nope'), 7 * 86_400_000, NOW)).toBeNull();
  });

  it('summarises first-try stages, retries and budget burn', () => {
    const dir = scratch();
    writeFileSync(join(dir, '92.json'), JSON.stringify(jobRecord(92, { pr: 116 })));
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0].item).toBe(92);
    expect(report.jobs[0].pr).toBe(116);
    expect(report.jobs[0].done).toBe(true);
    expect(report.jobs[0].stages).toHaveLength(3);
    expect(report.firstTryOk).toBe(3);
    expect(report.retries).toBe(0);
    // JOB_CAP_MS, not the sum of the stage budgets: the drainer clamps every stage to what
    // remains of the 100-minute job cap, so 103 minutes is a ceiling no job can reach.
    expect(report.jobs[0].budgetMs).toBe(100 * 60_000);
    expect(report.jobs[0].burnPct).toBeCloseTo(400_000 / (100 * 60_000) * 100, 1);
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
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
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
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.jobs.map((j) => j.item)).toEqual([91]);
  });

  it('does not count a skipped stage: a clean review is not a failed fix', () => {
    const dir = scratch();
    // factory-jobs.ts pushes this row when the reviewer's verdict is `clean` and the fix
    // stage is bypassed. The stage never ran, so it is neither a stage nor a first-try miss.
    writeFileSync(
      join(dir, '94.json'),
      JSON.stringify(
        jobRecord(94, {
          history: [
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'review', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'fix', endedAt: new Date(NOW).toISOString(), result: 'skipped' },
            { stage: 'deliver', endedAt: new Date(NOW).toISOString(), result: 'ok' },
          ],
        }),
      ),
    );
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.jobs[0].stages.map((s) => s.stage)).toEqual(['build', 'review', 'deliver']);
    expect(report.firstTryOk).toBe(3);
    expect(report.retries).toBe(0);
  });

  it("counts the fixer's nochange verdict as a first-try pass", () => {
    const dir = scratch();
    // The fixer may accept a finding without committing; the drainer verifies that verdict
    // in code and advances the job, so the stage succeeded on its first attempt.
    writeFileSync(
      join(dir, '95.json'),
      JSON.stringify(
        jobRecord(95, {
          history: [
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'review', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'fix', endedAt: new Date(NOW).toISOString(), result: 'nochange' },
          ],
        }),
      ),
    );
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.firstTryOk).toBe(3);
    expect(report.retries).toBe(0);
  });

  it("does not read the owner's retry stamp as a model retry", () => {
    const dir = scratch();
    // `factory-jobs retry <item>` stamps the current stage with `retried` before resuming it.
    writeFileSync(
      join(dir, '96.json'),
      JSON.stringify(
        jobRecord(96, {
          history: [
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'retried' },
            { stage: 'build', endedAt: new Date(NOW).toISOString(), result: 'ok' },
            { stage: 'review', endedAt: new Date(NOW).toISOString(), result: 'ok' },
          ],
        }),
      ),
    );
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.jobs[0].stages.find((s) => s.stage === 'build')).toMatchObject({ attempts: 1, firstTryOk: true });
    expect(report.firstTryOk).toBe(2);
    expect(report.retries).toBe(0);
  });

  it('prices the window burn against one budget per job', () => {
    const dir = scratch();
    writeFileSync(join(dir, '97.json'), JSON.stringify(jobRecord(97)));
    writeFileSync(join(dir, '98.json'), JSON.stringify(jobRecord(98)));
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    // Two jobs that each spent 400s are 800s of 200 minutes, never 800s of 100.
    expect(report.spentMs).toBe(800_000);
    expect(report.budgetMs).toBe(2 * 100 * 60_000);
  });

  it('survives an unparseable record by noting it', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'broken.json'), '{not json');
    const report = readLedger(dir, 7 * 86_400_000, NOW)!;
    expect(report.jobs).toHaveLength(0);
    expect(report.notes.some((n) => n.includes('broken.json'))).toBe(true);
  });
});
