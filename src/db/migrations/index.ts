import type { Migration } from './types.js';
import { migration as baseline } from './202606170000_baseline.js';
import { migration as actionAppliedMutations } from './202606171200_action_applied_mutations.js';
import { migration as playerLastPlayedAndNarrative } from './202606171400_player_last_played_and_narrative.js';
import { migration as playerLastRestedDay } from './202606180000_player_last_rested_day.js';
import { migration as rollRefundAndEnrichment } from './202606210000_roll_refund_and_enrichment.js';

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
];
