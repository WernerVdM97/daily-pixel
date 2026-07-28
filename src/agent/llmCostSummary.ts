/**
 * RA-4a: LLM-cost summary derived from the `llm_calls` audit table an agent-player run writes
 * (`recordLlmCalls: true`, `engineHarness.ts`, exposed as `.db`). Before this, nothing ever
 * queried that table — it lived and died with the run's `:memory:` DB the moment the process
 * exited. A small DB-in/data-out helper (no formatting) so it's unit-testable against
 * hand-inserted rows with no network — see `formatLlmCostSummary` below for the print half.
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

export interface LlmCostSummary {
  totalCalls: number;
  totalTokens: number;
  byCallKind: CallKindBreakdown[];
  criticVerdicts: CriticVerdictCount[];
  /** EXACT count of critic calls that could have changed something: (beat='decision' AND
   *  severity='major') OR (beat='resolution' AND severity='minor') — see `ACTIONABLE_CRITIC_NOTE`
   *  for the 2-of-6 rationale. Rows with no recorded beat are NOT folded in here — see
   *  `actionableCriticLegacyCount`. */
  actionableCritic: number;
  /** Critic rows with `beat IS NULL` — pre-migration (202607281200_llm_call_beat) rows that
   *  predate the `beat` column, or any future critic call that somehow skips stamping it. Kept
   *  separate from `actionableCritic` deliberately: "no beat recorded" is a data gap, not proof
   *  the verdict was inert, so folding it into (or silently dropping it from) the exact count
   *  would misrepresent an old DB's numbers as more precise than they are. */
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
  '`actionableCritic` counts exactly those two combinations via the `beat` column ' +
  '(202607281200_llm_call_beat). `actionableCriticLegacyCount` is critic rows with no `beat` ' +
  'recorded (pre-migration) — excluded from the exact count rather than guessed at, so an old DB ' +
  'degrades honestly instead of silently under-counting.';

/** Queries `llm_calls` for the RA-4a summary. Pure read — no writes, no formatting (that's
 *  `formatLlmCostSummary` below), so a caller that only wants the numbers (e.g. a future
 *  dashboard) never pays for string-building it won't use. */
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

  // Exact actionable count (the 2-of-6 rule, see ACTIONABLE_CRITIC_NOTE): only these two
  // beat×severity combinations can change anything. Rows with beat IS NULL (pre-migration) are
  // deliberately excluded here, not guessed at — they land in actionableCriticLegacyCount instead.
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

  return {
    totalCalls: totals.calls,
    totalTokens: totals.tokens,
    byCallKind,
    criticVerdicts: verdictRows,
    actionableCritic,
    actionableCriticLegacyCount,
    actionableCriticNote: ACTIONABLE_CRITIC_NOTE,
  };
}

/** Human-readable block matching the existing run-summary / playtest-critique print style in
 *  `play.ts` (a labelled header, indented lines, printed to stderr — never stdout, see that
 *  file's header comment on why). */
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
    lines.push(`  actionable critic: ${summary.actionableCritic}`);
    if (summary.actionableCriticLegacyCount > 0) {
      lines.push(`  actionable critic (legacy, no beat recorded): ${summary.actionableCriticLegacyCount}`);
    }
    lines.push(`  note: ${summary.actionableCriticNote}`);
  }
  return lines.join('\n');
}
