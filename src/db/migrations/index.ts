import type { Migration } from './types.js';
import { migration as baseline } from './202606170000_baseline.js';
import { migration as actionAppliedMutations } from './202606171200_action_applied_mutations.js';
import { migration as playerLastPlayedAndNarrative } from './202606171400_player_last_played_and_narrative.js';
import { migration as playerLastRestedDay } from './202606180000_player_last_rested_day.js';
import { migration as rollRefundAndEnrichment } from './202606210000_roll_refund_and_enrichment.js';
import { migration as dropLegacyActionLlmColumns } from './202606250000_drop_legacy_action_llm_columns.js';
import { migration as llmCallKind } from './202606250001_llm_call_kind.js';
import { migration as llmCallCriticSeverity } from './202606260000_llm_call_critic_severity.js';
import { migration as feedbackBugActionId } from './202606260001_feedback_bug_action_id.js';
import { migration as geography } from './202606270000_geography.js';
import { migration as feedbackBugAppVersion } from './202606280000_feedback_bug_app_version.js';
import { migration as playerLastBailRefundDay } from './202606300000_player_last_bail_refund_day.js';

/**
 * All migrations in apply order. Append new ones at the end — the runner applies
 * any whose id is not yet in `schema_migrations`. Keep this list in filename
 * (chronological) order.
 */
export const MIGRATIONS: Migration[] = [
  baseline,
  actionAppliedMutations,
  playerLastPlayedAndNarrative,
  playerLastRestedDay,
  rollRefundAndEnrichment,
  dropLegacyActionLlmColumns,
  llmCallKind,
  llmCallCriticSeverity,
  feedbackBugActionId,
  geography,
  feedbackBugAppVersion,
  playerLastBailRefundDay,
];
