import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent-player PLAYTEST CRITIC family, set-based as of v2 — a second prompt family beside the
 * move-picker brain: it reads a whole transcript, where the in-game `critic/` family gates one beat.
 */
export const AGENT_CRITIC_SET_VERSION = 'v2';

/** The templates in the active critic set. */
export type CriticTemplate = 'critic' | 'persona-review';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The active set's directory. */
function setDir(): string {
  return path.join(__dirname, '..', '..', 'assets', 'prompts', 'agent-critic', AGENT_CRITIC_SET_VERSION);
}

/** `promptVersion` stamp for an `llm_calls` row produced by one template of the critic set.
 *  `agent-critic-v2/<template>`, derived, never hand-written. */
export function agentCriticStamp(template: CriticTemplate): string {
  return `agent-critic-${AGENT_CRITIC_SET_VERSION}/${template}`;
}

/** Read one template of the active set. Loaded once at gateway construction. Fails loud (ENOENT) if
 *  the file is missing — a critic with no prompt is a bug, not a soft fallback. */
export function loadCriticTemplate(template: CriticTemplate): string {
  return readFileSync(path.join(setDir(), `${template}.md`), 'utf-8').trim();
}
