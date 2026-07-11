// App version, read once from the repo-root VERSION file. Stored on each action
// row (and logged at boot) so historic data can be sliced by the build that
// produced it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_VERSION = readFileSync(
  path.join(__dirname, '..', 'VERSION'),
  'utf-8',
).trim();
