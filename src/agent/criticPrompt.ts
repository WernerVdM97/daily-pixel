import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prompt version for the agent-player PLAYTEST CRITIC family (JSON-seam M4.5). A second prompt
 * family beside the move-picker brain (`agentPrompt.ts`), following the same `prompt-versioning`
 * discipline: own folder `assets/prompts/agent-critic/`, versioned `agent-critic-<vN>.md` files (the
 * family name prefixes the file so it never collides with the in-game `critic/critic-<vN>.md`), a
 * `current_source.md` mirror, and this independent constant.
 *
 * Distinct from the in-game `critic/` family (`CRITIC_VERSION` in `prompt-builder.ts`): that critic
 * gates a SINGLE decision beat before it reaches a player (coherence correction); this one reads a
 * WHOLE completed playthrough transcript and writes a qualitative playtest report. Different role,
 * different input/output, different family — so a separate version line.
 *
 * As with `AGENT_PLAYER_VERSION`, the constant lives HERE in `src/agent/` (not in
 * `prompt-builder.ts`): the opt-in QA/playtest adapter (DA-5) owns its prompt families so core LLM
 * code never depends on a harness-only concern. Every row is stamped `agent-critic-${version}`.
 *
 * Bump it (and add `critic-<new>.md`, re-sync `current_source.md`) when the critic prompt changes;
 * never edit a published version in place.
 */
export const AGENT_CRITIC_VERSION = 'v1';

/** `promptVersion` stamp for an `llm_calls` row produced by the playtest critic. */
export const AGENT_CRITIC_STAMP = `agent-critic-${AGENT_CRITIC_VERSION}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read the playtest-critic system prompt matching {@link AGENT_CRITIC_VERSION}, loaded once at
 *  gateway construction. Fails loud (ENOENT) if missing — a critic with no prompt is a bug, not a
 *  soft fallback (same contract as `loadAgentPrompt`). */
export function loadCriticPrompt(version: string = AGENT_CRITIC_VERSION): string {
  return readFileSync(
    path.join(__dirname, '..', '..', 'assets', 'prompts', 'agent-critic', `agent-critic-${version}.md`),
    'utf-8',
  ).trim();
}
