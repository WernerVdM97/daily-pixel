import type { Migration } from './types.js';
import { migration as baseline } from './202606170000_baseline.js';
import { migration as actionAppliedMutations } from './202606171200_action_applied_mutations.js';

/**
 * All migrations in apply order. Append new ones at the end — the runner applies
 * any whose id is not yet in `schema_migrations`. Keep this list in filename
 * (chronological) order.
 */
export const MIGRATIONS: Migration[] = [
  baseline,
  actionAppliedMutations,
];
