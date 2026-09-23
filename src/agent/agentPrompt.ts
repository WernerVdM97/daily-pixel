import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The agent-player brain family is SET-BASED: the runtime unit is the whole version directory — brain,
 * handbook and the persona fragment `AGENT_PERSONA` selects, loaded and stamped together.
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

/** Read `brain.md` — the move-picker's core instruction. Loaded once at gateway construction; fails
 *  loud (ENOENT) if the file is missing: a brain with no prompt is a bug, not a soft fallback. */
export function loadBrainPrompt(): string {
  return readFileSync(path.join(setDir(), 'brain.md'), 'utf-8').trim();
}

/** Read `handbook.md` — what a first-time player needs to know. Part of the same set as `brain.md`
 *  and composed into the same system prompt (see `ProdAgentPlayerGateway`). */
export function loadHandbookPrompt(): string {
  return readFileSync(path.join(setDir(), 'handbook.md'), 'utf-8').trim();
}

/** The ten persona fragments in the spec's Roster order, lowercase, and the only names
 *  `loadPersonaFragment` accepts. `play.ts` validates `AGENT_PERSONA` against them before any LLM call. */
export const PERSONA_NAMES: readonly string[] = [
  'explorer',
  'socialite',
  'soldier',
  'homesteader',
  'grinder',
  'collector',
  'storyteller',
  'tourist',
  'casual',
  'lapsed-returner',
];

/** The `personas/` directory of the active set. */
function personaDir(): string {
  return path.join(setDir(), 'personas');
}

/** Read one `personas/<name>.md` fragment, which rides the SYSTEM prompt after `brain.md` and the
 *  handbook. Fails loud on an unknown name or a missing directory, naming the valid names or the path. */
export function loadPersonaFragment(name: string): string {
  if (!PERSONA_NAMES.includes(name)) {
    throw new Error(
      `agentPlayer: unknown persona "${name}"; valid personas: ${PERSONA_NAMES.join(', ')}`,
    );
  }
  const dir = personaDir();
  try {
    return readFileSync(path.join(dir, `${name}.md`), 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`agentPlayer: no persona fragments at ${dir} (expected ${name}.md)`);
    }
    throw err;
  }
}
