import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent-player brain family is SET-BASED as of v2 (spec § Versioning and wiring,
 * `docs/engine/agent-player-personas.md`): the runtime unit is the whole version directory —
 * `brain.md` plus the `handbook.md` every brain carries, joined later by the `personas/*.md`
 * fragments T3 adds — fired together for one turn and stamped as a unit. The `v1` single file
 * stays on disk, frozen, because rows already produced are stamped `agent-v1` and must stay
 * attributable.
 *
 * Follows the `prompt-versioning` skill's set-based rules: one `*_SET_VERSION` constant names the
 * set, per-call stamps are derived by {@link agentPlayerStamp} (`agent-v2`, or `agent-v2/<persona>`)
 * rather than hand-written, and `current_source/` is a byte-identical directory mirror of the
 * active version directory.
 *
 * The constant lives HERE, in `src/agent/`, not in `src/llm/prompt-builder.ts`: `src/agent/` is an
 * opt-in QA/playtest adapter (DA-5) that core LLM code must never depend on, so its prompt family
 * owns its own version rather than tangling `prompt-builder.ts` (imported across the live path)
 * into a harness-only concern.
 */
export const AGENT_PLAYER_SET_VERSION = 'v2';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The active set's directory. */
function setDir(): string {
  return path.join(__dirname, '..', '..', 'assets', 'prompts', 'agent-player', AGENT_PLAYER_SET_VERSION);
}

/** `promptVersion` stamp for an `llm_calls` row produced by the agent brain. `agent-v2`, or
 *  `agent-v2/<persona>` when a persona fragment rode the turn. Derived, never hand-written. */
export function agentPlayerStamp(persona?: string): string {
  const base = `agent-${AGENT_PLAYER_SET_VERSION}`;
  return persona ? `${base}/${persona}` : base;
}

/** Read `brain.md` — the move-picker's core instruction. Loaded once at gateway construction.
 *  Fails loud (ENOENT) if the file is missing: a brain with no prompt is a bug, not a soft
 *  fallback. */
export function loadBrainPrompt(): string {
  return readFileSync(path.join(setDir(), 'brain.md'), 'utf-8').trim();
}

/** Read `handbook.md` — what a first-time player needs to know (spec § D). Part of the same set as
 *  `brain.md` and composed into the same system prompt (see `ProdAgentPlayerGateway`). */
export function loadHandbookPrompt(): string {
  return readFileSync(path.join(setDir(), 'handbook.md'), 'utf-8').trim();
}
