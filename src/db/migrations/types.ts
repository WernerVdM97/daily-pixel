import type Database from 'better-sqlite3';

/**
 * One ordered, idempotent schema migration.
 *
 * Files are named `YYYYMMDDHHMM_description.ts` so they sort into apply order by
 * filename. Each exports a `migration` whose `id` matches the filename stem. The
 * runner (see ../migrate.ts) records applied ids in `schema_migrations` and skips
 * them on subsequent boots.
 */
export interface Migration {
  /** Unique, sortable id — must match the filename stem. */
  id: string;
  /** Apply the change. Should be safe to re-run (the runner skips applied ids,
   *  but existing production DBs predate the runner, so `up` still uses
   *  IF NOT EXISTS / column-existence guards). */
  up(db: Database.Database): void;
}
