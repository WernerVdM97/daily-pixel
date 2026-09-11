import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordDigest, renderVerdict, resolveVerdict } from '../../scripts/factory-inbox';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/factory-inbox.ts');
const REPO_ROOT = resolve(dirname(SCRIPT), '..');

// The vocabulary is the whole answer protocol: 1️⃣…5️⃣ approve that proposal, ✅ all, ❌ "the
// rest", 🔁 re-run, ⏸ hold. These tests pin what a combination of taps means, because the
// resolution has to be one mechanical answer rather than a model's reading of a reaction list.
type Intent = 'approve' | 'reject' | 'rerun' | 'hold';
const tap = (emoji: string, intent: Intent, proposal: number | null = null, fresh = 1) => ({
  emoji,
  intent,
  proposal,
  fresh,
  // A stale vote is one the owner really left, already counted in an earlier drain.
  count: fresh === 0 ? 1 : fresh,
});

describe('resolving a digest verdict', () => {
  it('reads ❌ as "the rest": 1️⃣ 2️⃣ ❌ is approve 1 and 2, reject 3', () => {
    const verdict = resolveVerdict([tap('1️⃣', 'approve', 1), tap('2️⃣', 'approve', 2), tap('❌', 'reject')], 3);
    expect(verdict.proposals).toEqual([
      { proposal: 1, verdict: 'approve' },
      { proposal: 2, verdict: 'approve' },
      { proposal: 3, verdict: 'reject' },
    ]);
    expect(verdict.rejectRest).toBe(true);
  });

  it('still rejects everything when ❌ is tapped alone', () => {
    const verdict = resolveVerdict([tap('❌', 'reject')], 3);
    expect(verdict.proposals.map((p) => p.verdict)).toEqual(['reject', 'reject', 'reject']);
  });

  it('leaves the untapped proposals unanswered rather than rejected', () => {
    const verdict = resolveVerdict([tap('2️⃣', 'approve', 2)], 3);
    expect(verdict.proposals).toEqual([
      { proposal: 1, verdict: 'no answer' },
      { proposal: 2, verdict: 'approve' },
      { proposal: 3, verdict: 'no answer' },
    ]);
  });

  it('approves every proposal on ✅, and lets approval win over a contradictory ❌', () => {
    expect(resolveVerdict([tap('✅', 'approve')], 2).proposals.map((p) => p.verdict)).toEqual(['approve', 'approve']);

    const both = resolveVerdict([tap('✅', 'approve'), tap('❌', 'reject')], 2);
    expect(both.proposals.map((p) => p.verdict)).toEqual(['approve', 'approve']);
    expect(both.notes.join(' ')).toContain('approval wins');
  });

  it('says nothing was answered when no reaction is present', () => {
    const verdict = resolveVerdict([], 2);
    expect(verdict.proposals.map((p) => p.verdict)).toEqual(['no answer', 'no answer']);
    expect(verdict.approveAll).toBe(false);
    expect(verdict.hold).toBe(false);
  });

  it('does not re-apply a reaction already counted in an earlier drain', () => {
    const verdict = resolveVerdict([tap('1️⃣', 'approve', 1, 0)], 2);
    expect(verdict.proposals.map((p) => p.verdict)).toEqual(['no answer', 'no answer']);
    expect(verdict.notes.join(' ')).toContain('already counted in an earlier drain');
  });

  it('carries ⏸ and 🔁 as flags with a note, still recording the verdict underneath', () => {
    const held = resolveVerdict([tap('1️⃣', 'approve', 1), tap('⏸', 'hold')], 2);
    expect(held.hold).toBe(true);
    expect(held.proposals[0]).toEqual({ proposal: 1, verdict: 'approve' });
    expect(held.notes.join(' ')).toContain('apply nothing');

    const rerun = resolveVerdict([tap('🔁', 'rerun')], 2);
    expect(rerun.rerun).toBe(true);
    expect(rerun.notes.join(' ')).toContain('apply nothing');
  });

  it('does not pretend to know the count when the digest never stored one', () => {
    // `✅` on a digest recorded without `--seed <n>` means every proposal: reporting it as
    // "approve 1" because that keycap was also tapped would understate the decision.
    const verdict = resolveVerdict([tap('1️⃣', 'approve', 1), tap('✅', 'approve')], null);
    expect(verdict.proposals).toEqual([]);
    expect(verdict.countKnown).toBe(false);
    expect(verdict.approvedByKeycap).toEqual([1]);
    expect(verdict.approveAll).toBe(true);
    expect(verdict.notes.join(' ')).toContain('--seed');
  });

  it('names no proposal when the count is unknown, and says how to fix that', () => {
    const verdict = resolveVerdict([tap('✅', 'approve')], null);
    expect(verdict.proposals).toEqual([]);
    expect(verdict.approveAll).toBe(true);
    expect(verdict.notes.join(' ')).toContain('--seed');
  });

  it('covers a five-proposal digest', () => {
    const taps = [
      tap('1️⃣', 'approve', 1),
      tap('2️⃣', 'approve', 2),
      tap('4️⃣', 'approve', 4),
      tap('❌', 'reject'),
    ];
    expect(resolveVerdict(taps, 5).proposals.map((p) => `${p.proposal}:${p.verdict}`)).toEqual([
      '1:approve',
      '2:approve',
      '3:reject',
      '4:approve',
      '5:reject',
    ]);
  });

  it('still records the keycaps it can see when there is no count to enumerate against', () => {
    const verdict = resolveVerdict([tap('3️⃣', 'approve', 3), tap('❌', 'reject')], null);
    expect(verdict.proposals).toEqual([]);
    expect(verdict.countKnown).toBe(false);
    expect(verdict.approvedByKeycap).toEqual([3]);
    expect(verdict.rejectRest).toBe(true);
  });
});

// The brief's verdict section is what the next run reads instead of the reaction list, so what it
// prints is the protocol. A hold or a re-run beside a per-proposal approval reads as two answers,
// and the approval is the one that changes a file.
describe('printing the verdict the agent reads', () => {
  it('resolves the taps proposal by proposal when the digest is being applied', () => {
    const v = resolveVerdict([tap('1️⃣', 'approve', 1), tap('❌', 'reject'), tap('3️⃣', 'approve', 3)], 3);
    expect(renderVerdict(v)).toEqual([
      '## Verdict (3 proposals)',
      '  approve: 1, 3',
      '  reject: 2',
      '  no answer: none',
    ]);
  });

  it('prints no approval to apply when the owner held the digest', () => {
    const v = resolveVerdict([tap('1️⃣', 'approve', 1), tap('⏸', 'hold')], 3);
    const lines = renderVerdict(v);
    expect(lines[0]).toContain('hold');
    expect(lines[0]).toContain('apply nothing');
    expect(lines.join('\n')).toContain('taps recorded: approve 1');
    expect(lines.join('\n')).not.toContain('approve: 1');
  });

  it('prints no approval to apply when the owner asked for a re-run', () => {
    const v = resolveVerdict([tap('✅', 'approve'), tap('🔁', 'rerun')], 3);
    const lines = renderVerdict(v);
    expect(lines[0]).toContain('re-run');
    expect(lines.join('\n')).toContain('taps recorded: ✅ approve every proposal');
    expect(lines.join('\n')).not.toContain('approve: 1, 2, 3');
  });

  it('says the digest carries no reaction rather than printing a bare "none"', () => {
    const lines = renderVerdict(resolveVerdict([], null));
    expect(lines).toEqual([
      '## Verdict (proposal count unknown)',
      '  approved by keycap: none',
      '  no answer: the digest carries no reaction',
    ]);
  });
});

// A digest is recorded by one loop and answered days later, and the state file is a single shared
// one, so what a new recording clears is a correctness property rather than bookkeeping.
describe('recording a digest message', () => {
  it('stores the proposal count alongside the message it belongs to', () => {
    const state = recordDigest({}, 'A', 3);
    expect(state.digestMessageId).toBe('A');
    expect(state.proposalCount).toBe(3);
    expect(state.digestRecordedAt).toBeTruthy();
  });

  it('clamps the stored count to the keycaps that can answer it', () => {
    expect(recordDigest({}, 'A', 8).proposalCount).toBe(5);
    expect(recordDigest({}, 'A', 0).proposalCount).toBe(1);
    expect(recordDigest({}, 'A', null).proposalCount).toBeUndefined();
  });

  it('clears the previous digest\'s count, so a new digest cannot be answered for', () => {
    // The leak: meta-oil records `--record A --seed 3`, scrumo then records `--record B` with no
    // seed. A surviving count of 3 names three proposals scrumo never sent, and a stale 3 on a
    // five-card digest hides proposals 4 and 5.
    const state = recordDigest({}, 'A', 3);
    recordDigest(state, 'B', null);
    expect(state.proposalCount).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('proposalCount');
  });

  it('clears the reaction baseline with it, so a fresh approval is not read as an old one', () => {
    const state = recordDigest({}, 'A', 3);
    state.reactionBaseline = { '1️⃣': 1 };
    recordDigest(state, 'B', 2);
    expect(state.reactionBaseline).toEqual({});
    expect(state.proposalCount).toBe(2);
  });

  it('keeps both when the same message is re-recorded', () => {
    const state = recordDigest({}, 'A', 3);
    state.reactionBaseline = { '1️⃣': 1 };
    recordDigest(state, 'A', null);
    expect(state.reactionBaseline).toEqual({ '1️⃣': 1 });
    expect(state.proposalCount).toBe(3);
  });
});

// The guard is what keeps an import from draining the owner's real inbox, and it is a silent
// no-op when it fails to match: `file://${argv[1]}` never matches a path that holds a space,
// because import.meta.url percent-encodes it. Run for real, from such a path.
describe('running the CLI as a script', () => {
  const run = (script: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'factory inbox '));
    mkdirSync(join(dir, 'scripts'));
    const copy = join(dir, 'scripts', script);
    copyFileSync(resolve(REPO_ROOT, 'scripts', script), copy);
    // The copy has to resolve tsx and discord.js, which live in the install.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
    return execFileSync(process.execPath, ['--import', 'tsx', copy, '--help'], { encoding: 'utf8', cwd: dir });
  };

  it('runs factory-inbox --help from a path with a space, rather than no-opping on exit 0', () => {
    expect(run('factory-inbox.ts')).toContain('Usage: tsx scripts/factory-inbox.ts');
  });

  it('runs send-dm --help from the same path', () => {
    expect(run('send-dm.ts')).toContain('Usage: tsx scripts/send-dm.ts');
  });
});
