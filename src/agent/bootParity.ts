/**
 * The boot state a deterministic recording and its replay must BOTH establish (M10.1d).
 *
 * Neither is `index.ts`, so neither inherits the bot's boot, and the two environments they
 * run in disagree by design: the vitest setup file seeds the emoji registry while the CLI
 * does not, and `migrate()` seeds the world for real runs but deliberately skips it under
 * VITEST. Left implicit, that produces a recording and a replay that differ for reasons
 * having nothing to do with the transcript — the failure mode is quiet, too: glyphs fall
 * back to placeholders and locations resolve to null rather than anything throwing.
 *
 * Both ends call this, so there is one definition of "booted" rather than two that drift.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

import { registerEmoji } from '../render/format.js';
import { loadYamlFile } from '../assets/yaml-loader.js';
import { ensureWorldSeeded } from '../db/migrate.js';

const CC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'char-creation');

export function establishBootParity(db: Database.Database): void {
  const load = (file: string) =>
    loadYamlFile(path.join(CC_DIR, file)) as Array<{ name: string; emoji?: string }>;
  registerEmoji('class', load('classes.yml'));
  registerEmoji('dayJob', load('day-jobs.yml'));
  ensureWorldSeeded(db);
}
