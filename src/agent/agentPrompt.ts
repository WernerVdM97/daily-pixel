import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prompt version for the agent-player brain family (JSON-seam M4.1). Follows the
 * `prompt-versioning` skill's discipline — own folder `assets/prompts/agent-player/`, versioned
 * `agent-<vN>.md` files, a `current_source.md` mirror, and this independent constant — with one
 * deliberate divergence: the constant lives HERE, in `src/agent/`, not in `src/llm/prompt-builder.ts`.
 *
 * Why: `src/agent/` is an opt-in QA/playtest adapter (DA-5) that core LLM code must never depend
 * on, so its prompt family owns its own version rather than tangling `prompt-builder.ts` (imported
 * across the live path) into a harness-only concern. Every row this family produces is stamped
 * `agent-${AGENT_PLAYER_VERSION}`, mirroring the critic family's `critic-<vN>` stamp.
 *
 * Bump it (and add `agent-<new>.md`, re-sync `current_source.md`) when the agent prompt changes;
 * never edit a published version in place.
 */
export const AGENT_PLAYER_VERSION = 'v1';

/** `promptVersion` stamp for an `llm_calls` row produced by the agent brain. */
export const AGENT_PLAYER_STAMP = `agent-${AGENT_PLAYER_VERSION}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read the agent-player system prompt matching {@link AGENT_PLAYER_VERSION}, loaded once at
 *  gateway construction. Fails loud (ENOENT) if the file is missing — a brain with no prompt is a
 *  bug, not a soft fallback. */
export function loadAgentPrompt(version: string = AGENT_PLAYER_VERSION): string {
  return readFileSync(
    path.join(__dirname, '..', '..', 'assets', 'prompts', 'agent-player', `agent-${version}.md`),
    'utf-8',
  ).trim();
}
