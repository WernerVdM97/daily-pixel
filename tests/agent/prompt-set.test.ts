/**
 * T2 — the set-based prompt families (spec § Versioning and wiring,
 * `docs/engine/agent-player-personas.md`). Two things are pinned here that no other test can see:
 *
 * - the `current_source/` DIRECTORY mirror is byte-identical to the version directory the
 *   `*_SET_VERSION` constant points at, file-for-file (the `prompt-versioning` skill's mirror rule
 *   made enforceable), and the replaced single-file `current_source.md` is gone;
 * - the handbook's roll figures are read against the engine's own `DAILY_ROLL_ALLOWANCE` and
 *   `SATURDAY_BONUS_ROLLS`, so the next copy drift fails here rather than in front of a player.
 *
 * The stamps are pinned as literals too: "derived, never hand-written" is a production rule, and a
 * test that derived the expectation from the same helper would assert nothing.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_PLAYER_SET_VERSION,
  agentPlayerStamp,
  loadBrainPrompt,
  loadHandbookPrompt,
} from '../../src/agent/agentPrompt.js';
import {
  AGENT_CRITIC_SET_VERSION,
  agentCriticStamp,
  loadCriticTemplate,
} from '../../src/agent/criticPrompt.js';
import { DAILY_ROLL_ALLOWANCE, SATURDAY_BONUS_ROLLS } from '../../src/engine/WorldEngineImpl.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS = path.join(ROOT, 'assets', 'prompts');

/** Every file under `dir`, as sorted paths relative to `dir`. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of filesUnder(path.join(dir, entry.name))) out.push(path.join(entry.name, inner));
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

function bytes(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('prompt-set mirrors (T2)', () => {
  const families: Array<[string, string]> = [
    ['agent-player', AGENT_PLAYER_SET_VERSION],
    ['agent-critic', AGENT_CRITIC_SET_VERSION],
  ];

  it.each(families)('%s/current_source mirrors %s file-for-file, byte-for-byte', (family, version) => {
    const versionDir = path.join(PROMPTS, family, version);
    const mirrorDir = path.join(PROMPTS, family, 'current_source');
    const files = filesUnder(versionDir);

    expect(files.length).toBeGreaterThan(0);
    expect(filesUnder(mirrorDir)).toEqual(files);
    for (const f of files) {
      expect(bytes(path.join(mirrorDir, f))).toBe(bytes(path.join(versionDir, f)));
    }
  });

  it.each(['agent-player', 'agent-critic'])(
    '%s no longer carries the single-file current_source.md mirror',
    (family) => {
      expect(existsSync(path.join(PROMPTS, family, 'current_source.md'))).toBe(false);
    },
  );

  it('keeps the frozen v1 files on disk for rows already stamped agent-v1', () => {
    expect(existsSync(path.join(PROMPTS, 'agent-player', 'agent-v1.md'))).toBe(true);
    expect(existsSync(path.join(PROMPTS, 'agent-critic', 'agent-critic-v1.md'))).toBe(true);
  });
});

describe('prompt-set stamps (T2)', () => {
  it('derives the agent-player stamp, with and without a persona', () => {
    expect(agentPlayerStamp()).toBe('agent-v2');
    expect(agentPlayerStamp('soldier')).toBe('agent-v2/soldier');
  });

  it('derives the critic stamp per template', () => {
    expect(agentCriticStamp('critic')).toBe('agent-critic-v2/critic');
    expect(agentCriticStamp('persona-review')).toBe('agent-critic-v2/persona-review');
  });

  it('names v2 as the active set for both families', () => {
    expect(AGENT_PLAYER_SET_VERSION).toBe('v2');
    expect(AGENT_CRITIC_SET_VERSION).toBe('v2');
  });
});

describe('loaders', () => {
  it('loads brain.md and the handbook from the active player set', () => {
    const brain = loadBrainPrompt();
    const handbook = loadHandbookPrompt();
    expect(brain).toContain('MOVES');
    // The reply contract T4 will parse must be asked for by the prompt that precedes it.
    for (const key of ['intent', 'arcNote', 'friction', 'dayNote', 'recurrence', 'once', 'periodic', 'ritual']) {
      expect(brain).toContain(key);
    }
    // And the working-memory sections T1 plumbs must be named, or the brain is handed blocks
    // it is never told it has.
    for (const header of ['RECAP', 'TODAY SO FAR', 'INTENT', 'ARC', 'LAST LOOK', 'LAST ROLL']) {
      expect(brain).toContain(header);
    }
    expect(handbook).toContain('seven-step wizard');
  });

  it('loads the critic template from the active critic set', () => {
    expect(loadCriticTemplate('critic')).toContain('PLAY LOG');
  });
});

describe('handbook roll economy (spec § D)', () => {
  const handbook = loadHandbookPrompt();
  const allowed = [DAILY_ROLL_ALLOWANCE, DAILY_ROLL_ALLOWANCE + SATURDAY_BONUS_ROLLS];

  it('states the daily allowance and the Saturday total from the engine constants', () => {
    const canonical = handbook.match(/You have \*\*(\d+) rolls a day\*\*, and \*\*(\d+) rolls on Saturdays\*\*/);
    expect(canonical).not.toBeNull();
    expect(Number(canonical![1])).toBe(DAILY_ROLL_ALLOWANCE);
    expect(Number(canonical![2])).toBe(DAILY_ROLL_ALLOWANCE + SATURDAY_BONUS_ROLLS);
  });

  it('carries no other roll figure that could drift', () => {
    // The `/help` copy already shipped "2 rolls per day" once; this catches the next copy that
    // restates the allowance somewhere the canonical sentence does not cover.
    const figures = [...handbook.matchAll(/(\d+)\s+rolls/gi)].map((m) => Number(m[1]));
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) expect(allowed).toContain(figure);
  });
});

describe('handbook coverage (spec § D)', () => {
  const handbook = loadHandbookPrompt();

  it('lists the ten commands plus the report pair', () => {
    for (const cmd of ['/join', '/hi', '/action', '/sleep', '/look', '/map', '/stats', '/backpack', '/journal', '/help', '/feedback', '/bug']) {
      expect(handbook).toContain(cmd);
    }
  });

  it('states the seven-step wizard, its steps in order, and the confirm screen', () => {
    expect(handbook).toContain('seven-step wizard');
    const steps = [...handbook.matchAll(/^([1-7])\. \*\*/gm)].map((m) => Number(m[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(handbook).toContain('Confirm');
  });

  it('states the interaction model and the year-long promise', () => {
    expect(handbook).toMatch(/button/i);
    expect(handbook).toContain('Custom');
    expect(handbook).toMatch(/December/);
    expect(handbook).toMatch(/world (advances|moves on)/i);
  });

  it('carries the emoji signal vocabulary', () => {
    for (const glyph of ['❤️', '⚡', '🎲', '💰', '💪', '🧠', '📖', '💬', '📍', '🛡️', '⚠️', '🧭']) {
      expect(handbook).toContain(glyph);
    }
  });
});
