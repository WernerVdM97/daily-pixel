/**
 * The boot state a recording and its replay must BOTH establish — neither is `index.ts`, so neither
 * inherits the bot's boot, and left implicit the two differ quietly (placeholder glyphs, null locations).
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
