import { describe, expect, it } from 'vitest';
import { resolveVerdict } from '../../scripts/factory-inbox';

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
