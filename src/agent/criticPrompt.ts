import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent-player PLAYTEST CRITIC family, set-based as of v2 (spec § Versioning and wiring). A
 * second prompt family beside the move-picker brain (`agentPrompt.ts`), following the same
 * `prompt-versioning` discipline: own folder `assets/prompts/agent-critic/`, one `*_SET_VERSION`
 * constant naming the whole version directory, derived `agent-critic-v2/<template>` stamps, and a
 * byte-identical `current_source/` directory mirror. The `v1` single file stays on disk, frozen, for
 * the rows stamped `agent-critic-v1`. `critic.md` is the expert design critic; `persona-review.md`
 * (T5) is the player-voice review, a different template in the same set.
 *
 * Distinct from the in-game `critic/` family (`CRITIC_VERSION` in `prompt-builder.ts`): that critic
 * gates a SINGLE decision beat before it reaches a player (coherence correction); this one reads a
 * WHOLE completed playthrough transcript and writes a qualitative playtest report. Different role,
 * different input/output, different family — so a separate version line.
 *
 * As with `AGENT_PLAYER_SET_VERSION`, the constant lives HERE in `src/agent/` (not in
 * `prompt-builder.ts`): the opt-in QA/playtest adapter (DA-5) owns its prompt families so core LLM
 * code never depends on a harness-only concern.
 */
export const AGENT_CRITIC_SET_VERSION = 'v2';

/** The templates in the active critic set. `persona-review` arrives in T5. */
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
