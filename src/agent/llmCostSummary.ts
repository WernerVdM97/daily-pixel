/**
 * LLM-cost summary over the `llm_calls` rows a run writes with `recordLlmCalls: true` — rows that
 * otherwise live and die with the run's `:memory:` DB. DB-in/data-out; the print half is below.
 */

import type Database from 'better-sqlite3';

export interface CallKindBreakdown {
  callKind: string;
  calls: number;
  tokens: number;
  /** Share of ALL calls in the run (0..1). */
  callShare: number;
  /** Share of ALL tokens in the run (0..1). */
  tokenShare: number;
}

export interface CriticVerdictCount {
  /** null = a critic call recorded with no verdict (transport error/parse failure — the critic
   *  fails open to `ok` gameplay-side, but the audit row itself carries no severity). */
  severity: 'ok' | 'minor' | 'major' | null;
  count: number;
}

/** Critic spend split by which beat it reviewed: a `major` verdict fires a bounded re-decide on a
 *  decide beat but is discarded on a narrate one, so the two halves' value differs. */
export interface CriticBeatBreakdown {
  /** `'decision'` | `'resolution'`, or null for rows predating the `beat` column. */
  beat: string | null;
  calls: number;
  tokens: number;
  /** Verdicts that were not `ok` — the ones that even reached a branch that might act. */
  nonOkVerdicts: number;
}

export interface LlmCostSummary {
  totalCalls: number;
  totalTokens: number;
  byCallKind: CallKindBreakdown[];
  criticVerdicts: CriticVerdictCount[];
  /** Critic calls/tokens split by reviewed beat — see `CriticBeatBreakdown`. */
  criticByBeat: CriticBeatBreakdown[];
  /** Critic calls that could have changed something (see `ACTIONABLE_CRITIC_NOTE`). Exact on the
   *  decide arm, a tight upper bound on the narrate arm; beat-less rows are counted separately. */
  actionableCritic: number;
  /** Critic rows with `beat IS NULL` — rows predating the `beat` column. Kept apart from
   *  `actionableCritic` deliberately: "no beat recorded" is a data gap, not proof of inertness. */
  actionableCriticLegacyCount: number;
  /** Explains the 2-of-6 rationale behind `actionableCritic` and what `actionableCriticLegacyCount`
   *  means for a DB that predates the `beat` column. */
  actionableCriticNote: string;
}

const ACTIONABLE_CRITIC_NOTE =
  'Per the 2-of-6 rule (PipelineActionStateMachine.ts critiqueDecide/critiqueNarration), a critic ' +
  'verdict can only change something on (decide beat, major) or (narrate beat, minor with ' +
  'patch.outcomeText) — the other 4 beat×severity combinations are pure spend (decide+minor and ' +
  'narrate+major are explicit pass-through no-ops; ok is never actionable by definition). ' +
  '`actionableCritic` counts those two combinations via the `beat` column ' +
  '(202607281200_llm_call_beat). Caveat: that is exact for the decide arm, but a tight upper ' +
  'bound for the narrate arm — critiqueNarration only applies a minor verdict when it carries a ' +
  'patch.outcomeText, and patch presence is not recorded on the row, so a minor narrate verdict ' +
  'with no patch is counted here despite being inert. Treat the figure as "verdicts that reached ' +
  'an acting branch", not "verdicts that demonstrably changed output". ' +
  '`actionableCriticLegacyCount` is critic rows with no `beat` recorded (pre-migration) — ' +
  'excluded rather than guessed at, so an old DB degrades honestly instead of under-counting.';

/** Query `llm_calls` for the summary. Pure read, no formatting — a caller that only wants numbers
 *  never pays for the string-building `formatLlmCostSummary` does. */
export function summarizeLlmCosts(db: Database.Database): LlmCostSummary {
  const totals = db
    .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens FROM llm_calls`)
    .get() as { calls: number; tokens: number };

  const kindRows = db
    .prepare(
      `SELECT call_kind AS callKind, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM llm_calls
       GROUP BY call_kind
       ORDER BY calls DESC`,
    )
    .all() as Array<{ callKind: string; calls: number; tokens: number }>;

  const byCallKind: CallKindBreakdown[] = kindRows.map((row) => ({
    ...row,
    callShare: totals.calls > 0 ? row.calls / totals.calls : 0,
    tokenShare: totals.tokens > 0 ? row.tokens / totals.tokens : 0,
  }));

  const verdictRows = db
    .prepare(
      `SELECT critic_severity AS severity, COUNT(*) AS count
       FROM llm_calls
       WHERE call_kind = 'critic'
       GROUP BY critic_severity`,
    )
    .all() as Array<{ severity: 'ok' | 'minor' | 'major' | null; count: number }>;

  // The 2-of-6 rule (see ACTIONABLE_CRITIC_NOTE): only these two beat×severity combinations can
  // change anything. Beat-less rows are excluded here and counted by actionableCriticLegacyCount.
  const { actionableCritic } = db
    .prepare(
      `SELECT COUNT(*) AS actionableCritic
       FROM llm_calls
       WHERE call_kind = 'critic'
         AND ((beat = 'decision' AND critic_severity = 'major')
           OR (beat = 'resolution' AND critic_severity = 'minor'))`,
    )
    .get() as { actionableCritic: number };

  const { actionableCriticLegacyCount } = db
    .prepare(
      `SELECT COUNT(*) AS actionableCriticLegacyCount
       FROM llm_calls
       WHERE call_kind = 'critic' AND beat IS NULL`,
    )
    .get() as { actionableCriticLegacyCount: number };

  // The per-beat split the actionable count alone cannot give: it says how many narrate critic calls
  // were paid for, which is the comparison that decides whether either half of the critic earns its keep.
  const beatRows = db
    .prepare(
      `SELECT beat, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens,
              SUM(CASE WHEN critic_severity NOT IN ('ok') THEN 1 ELSE 0 END) AS nonOkVerdicts
       FROM llm_calls
       WHERE call_kind = 'critic'
       GROUP BY beat`,
    )
    .all() as Array<{ beat: string | null; calls: number; tokens: number; nonOkVerdicts: number | null }>;

  const criticByBeat: CriticBeatBreakdown[] = beatRows.map((row) => ({
    beat: row.beat,
    calls: row.calls,
    tokens: row.tokens,
    nonOkVerdicts: row.nonOkVerdicts ?? 0,
  }));

  return {
    totalCalls: totals.calls,
    totalTokens: totals.tokens,
    byCallKind,
    criticVerdicts: verdictRows,
    criticByBeat,
    actionableCritic,
    actionableCriticLegacyCount,
    actionableCriticNote: ACTIONABLE_CRITIC_NOTE,
  };
}

/** Human-readable block matching the run-summary / playtest-critique print style in `play.ts`: a
 *  labelled header and indented lines, printed to stderr — never stdout. */
export function formatLlmCostSummary(summary: LlmCostSummary): string {
  const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
  const lines: string[] = [
    '── llm cost summary ──',
    `  ${summary.totalCalls} call(s), ${summary.totalTokens} token(s)`,
  ];
  for (const row of summary.byCallKind) {
    lines.push(
      `  ${row.callKind}: ${row.calls} call(s) (${pct(row.callShare)} of calls), ` +
        `${row.tokens} token(s) (${pct(row.tokenShare)} of tokens)`,
    );
  }
  if (summary.criticVerdicts.length > 0) {
    const verdictText = summary.criticVerdicts
      .map((v) => `${v.severity ?? 'null'}=${v.count}`)
      .join(', ');
    lines.push(`  critic verdicts: ${verdictText}`);
    for (const row of summary.criticByBeat) {
      lines.push(
        `  critic ${row.beat ?? 'no-beat-recorded'}: ${row.calls} call(s), ${row.tokens} token(s), ` +
          `${row.nonOkVerdicts} non-ok verdict(s)`,
      );
    }
    lines.push(`  actionable critic: ${summary.actionableCritic}`);
    if (summary.actionableCriticLegacyCount > 0) {
      lines.push(`  actionable critic (legacy, no beat recorded): ${summary.actionableCriticLegacyCount}`);
    }
    lines.push(`  note: ${summary.actionableCriticNote}`);
  }
  return lines.join('\n');
}
