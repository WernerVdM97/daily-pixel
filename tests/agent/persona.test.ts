/**
 * T3 — the persona fragments, their loader, and the wiring that carries a persona into the system
 * prompt, the `llm_calls` stamp and the protocol-log header (spec § A and § Versioning and wiring,
 * `docs/engine/agent-player-personas.md`).
 *
 * The load-bearing test here is the **offline anti-theatre check** (spec § A: "personas must be
 * verifiable, not theatre"). The live half of that check needs a paid panel run and a verb
 * histogram; this is the half that can be decided here, and it is not cosmetic: two personas whose
 * `Want` or `Quit condition` cannot be told apart are decoration whatever their verb counts later
 * say.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_PLAYER_SET_VERSION,
  PERSONA_NAMES,
  agentPlayerStamp,
  loadBrainPrompt,
  loadHandbookPrompt,
  loadPersonaFragment,
} from '../../src/agent/agentPrompt.js';
import { ProdAgentPlayerGateway } from '../../src/agent/ProdAgentPlayerGateway.js';
import { AgentHarness } from '../../src/agent/harness.js';
import { ScriptedAgentPlayerGateway } from '../../src/agent/ScriptedAgentPlayerGateway.js';
import type { ChooseMoveInput, LegalMove } from '../../src/agent/AgentPlayerGateway.js';
import type { AgentObserver } from '../../src/agent/observer.js';
import type { GameRouter } from '../../src/protocol/router.js';
import type { LlmCallRecord } from '../../src/llm/LlmCallRecorder.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERSONA_DIR = path.join(ROOT, 'assets', 'prompts', 'agent-player', AGENT_PLAYER_SET_VERSION, 'personas');

// ── the missing-directory arm needs a filesystem that fails ──
// `loadPersonaFragment` must distinguish "unknown persona" from "the persona directory is gone",
// and the only way to reach the second arm without mutating the repo is to make the read fail.

const fsMock = vi.hoisted(() => ({ failPersonaDir: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (file: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (fsMock.failPersonaDir && String(file).includes('personas')) {
        const err = new Error(`ENOENT: no such file or directory, open '${String(file)}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return (actual.readFileSync as (...args: unknown[]) => string)(file, ...rest);
    },
  };
});

const PERSONA_LABELS = ['Voice', 'Priors', 'Want', 'Quit condition'] as const;

/** The fragment split into its four labelled sections: the label's own line, then everything up to
 *  the next label (the Priors bullets, for example). */
function sections(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | undefined;
  for (const line of fragment.split('\n')) {
    const match = line.match(/^\*\*(Voice|Priors|Want|Quit condition):\*\* ?(.*)$/);
    if (match) {
      current = match[1];
      out[current] = match[2];
    } else if (current !== undefined) {
      out[current] += `\n${line}`;
    }
  }
  return out;
}

/** The value written on a section's own label line, or null when the label is absent. */
function labelledLine(fragment: string, label: string): string | null {
  const section = sections(fragment)[label]?.trim();
  if (!section) return null;
  return section.split('\n')[0].trim();
}

function readFragment(name: string): string {
  return readFileSync(path.join(PERSONA_DIR, `${name}.md`), 'utf-8');
}

// ── the roster ──

describe('PERSONA_NAMES (spec § A)', () => {
  it('is exactly the ten roster names, in roster order', () => {
    expect(PERSONA_NAMES).toEqual([
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
    ]);
  });

  it('is all lowercase, so the name is a filename and a stamp without translation', () => {
    for (const name of PERSONA_NAMES) expect(name).toBe(name.toLowerCase());
  });
});

describe('the ten fragments', () => {
  it.each([...PERSONA_NAMES])('%s loads and carries the four labels in order', (name) => {
    const fragment = loadPersonaFragment(name);

    expect(fragment.length).toBeGreaterThan(0);
    const labels = PERSONA_LABELS.map((l) => `**${l}:**`);
    const offsets = labels.map((l) => fragment.indexOf(l));
    expect(offsets.every((i) => i >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    // One label per line: the anti-theatre parse below depends on it, and a label wrapped into
    // prose would parse as absent.
    for (const label of labels) expect(fragment).toContain(`\n${label}`);
  });

  it.each([...PERSONA_NAMES])('%s names verb families the harness actually offers', (name) => {
    const fragment = loadPersonaFragment(name);
    const priors = sections(fragment)['Priors'] ?? '';
    // Priors must cover the four things spec § A asks for: which verb families it favours, its
    // risk appetite, how long it plays before `/sleep`, and what it does when a thread stalls.
    for (const aspect of ['Verb families', 'Risk appetite', 'sleep', 'stalls']) {
      expect(priors, `${name}'s Priors say nothing about ${aspect}`).toContain(aspect);
    }
  });

  it.each([...PERSONA_NAMES])('%s carries no mechanical vote-weighting (spec § A)', (name) => {
    // A persona that biases the picker by rule, weight or index is a rig, not a player. The
    // fragments are prose about what the player wants, so the vocabulary of a rig must not appear.
    expect(readFragment(name)).not.toMatch(/\bvote|weighting|\bweight\b|index|priority pick\b/i);
  });

  it('is mirrored byte-for-byte into current_source/ (the versioning skill)', () => {
    for (const name of PERSONA_NAMES) {
      const mirror = readFileSync(
        path.join(ROOT, 'assets', 'prompts', 'agent-player', 'current_source', 'personas', `${name}.md`),
        'utf-8',
      );
      expect(mirror).toBe(readFragment(name));
    }
  });
});

// ── the offline half of spec § A's anti-theatre test ──

describe('anti-theatre: the ten are actually different personas', () => {
  const wants = PERSONA_NAMES.map((name) => labelledLine(loadPersonaFragment(name), 'Want'));
  const quits = PERSONA_NAMES.map((name) => labelledLine(loadPersonaFragment(name), 'Quit condition'));

  it('gives every persona a non-trivial Want and Quit condition', () => {
    for (const [i, name] of PERSONA_NAMES.entries()) {
      expect(wants[i], `${name} has no Want`).not.toBeNull();
      expect(quits[i], `${name} has no Quit condition`).not.toBeNull();
      // "Non-trivially non-empty": a whole clause naming a specific want/trigger, not a shrug.
      expect(wants[i]!.length, `${name}'s Want is too thin`).toBeGreaterThan(20);
      expect(quits[i]!.length, `${name}'s Quit condition is too thin`).toBeGreaterThan(20);
      expect(wants[i]!.split(/\s+/).length, `${name}'s Want is too thin`).toBeGreaterThan(3);
      expect(quits[i]!.split(/\s+/).length, `${name}'s Quit condition is too thin`).toBeGreaterThan(3);
    }
  });

  it('has pairwise distinct Wants', () => {
    expect(new Set(wants).size).toBe(PERSONA_NAMES.length);
  });

  it('has pairwise distinct Quit conditions', () => {
    expect(new Set(quits).size).toBe(PERSONA_NAMES.length);
  });
});

// ── the loader's failure arms ──

describe('loadPersonaFragment', () => {
  it('throws on an unknown name, listing the valid personas', () => {
    let message = '';
    try {
      loadPersonaFragment('wanderer');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('wanderer');
    for (const name of PERSONA_NAMES) expect(message).toContain(name);
  });

  it('throws a clear message naming the directory when the fragments are missing', () => {
    fsMock.failPersonaDir = true;
    try {
      let message = '';
      try {
        loadPersonaFragment('explorer');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('no persona fragments');
      expect(message).toContain(PERSONA_DIR);
    } finally {
      fsMock.failPersonaDir = false;
    }
  });
});

// ── wiring: the system prompt, the stamp, the header ──

const CHARACTER = {
  name: 'Bram',
  class: 'Town Guard',
  health: 12,
  maxHealth: 12,
  stamina: 10,
  maxStamina: 10,
  rollsRemaining: 3,
  wealth: 5,
  location: "The Warden's Oak",
};

const MENU_MOVES: LegalMove[] = [
  { move: { kind: 'menu-pick', index: 0 }, label: 'Patrol the walls' },
  { move: { kind: 'custom', text: '' }, label: 'Type your own action' },
  { move: { kind: 'sleep' }, label: 'Go to sleep' },
];

function menuInput(): ChooseMoveInput {
  return { screenText: '⚔️ Action\n\nPick a task.', moves: MENU_MOVES, character: CHARACTER };
}

function mockFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(body) }, finish_reason: 'stop' }] }),
    text: () => Promise.resolve(''),
  }) as unknown as typeof fetch;
}

function systemPromptOf(fetchFn: typeof fetch): string {
  const calls = (fetchFn as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls;
  return JSON.parse(calls[0][1].body).messages[0].content as string;
}

describe('the persona rides the system prompt and the stamp (spec § Versioning and wiring)', () => {
  it('is brain.md + handbook.md + the fragment, in that order', async () => {
    const fetchFn = mockFetch({ choice: 0 });
    await new ProdAgentPlayerGateway({ apiKey: 'k', fetch: fetchFn, persona: 'explorer' }).chooseMove(menuInput());

    const system = systemPromptOf(fetchFn);
    expect(system).toBe([loadBrainPrompt(), loadHandbookPrompt(), loadPersonaFragment('explorer')].join('\n\n'));
  });

  it('adds nothing at all when no persona is set (the baseline arm)', async () => {
    const fetchFn = mockFetch({ choice: 0 });
    await new ProdAgentPlayerGateway({ apiKey: 'k', fetch: fetchFn }).chooseMove(menuInput());

    expect(systemPromptOf(fetchFn)).toBe([loadBrainPrompt(), loadHandbookPrompt()].join('\n\n'));
    expect(systemPromptOf(fetchFn)).not.toContain('Persona:');
  });

  it('stamps agent-v2/<persona>, and plain agent-v2 when unset', async () => {
    const records: LlmCallRecord[] = [];
    const recorder = {
      record: (r: LlmCallRecord) => {
        records.push(r);
        return records.length;
      },
      promoteDeepCapture: () => {
        /* unused */
      },
    };

    await new ProdAgentPlayerGateway({ apiKey: 'k', fetch: mockFetch({ choice: 0 }), recorder, persona: 'soldier' })
      .chooseMove(menuInput());
    expect(records[0].promptVersion).toBe('agent-v2/soldier');

    await new ProdAgentPlayerGateway({ apiKey: 'k', fetch: mockFetch({ choice: 0 }), recorder })
      .chooseMove(menuInput());
    expect(records[1].promptVersion).toBe('agent-v2');

    // The literals above are the contract; this pins the derivation they must keep matching.
    expect(agentPlayerStamp('soldier')).toBe(`agent-${AGENT_PLAYER_SET_VERSION}/soldier`);
    expect(agentPlayerStamp()).toBe(`agent-${AGENT_PLAYER_SET_VERSION}`);
  });
});

// The constructor writes the header before any play, so a header test needs no engine: the two
// collaborators are never touched. Cast stubs keep this suite off the boot path (and off the
// network) entirely.
function harnessWith(persona?: string): AgentHarness {
  return new AgentHarness(
    {} as unknown as AgentObserver,
    {} as unknown as GameRouter,
    new ScriptedAgentPlayerGateway([]),
    'agent:persona-test',
    { recordedAt: '2026-09-14T00:00:00.000Z', ...(persona === undefined ? {} : { persona }) },
  );
}

describe('the protocol-log header carries the persona (spec § H)', () => {
  it('stamps the persona when one is set', () => {
    expect(harnessWith('explorer').transcript.protocol[0]).toMatchObject({ persona: 'explorer' });
  });

  it('omits the key entirely when unset (T1 pinned the pre-persona header shape)', () => {
    const header = harnessWith().transcript.protocol[0] as unknown as Record<string, unknown>;
    expect('persona' in header).toBe(false);
    expect(header).toEqual({
      seq: 0,
      kind: 'header',
      v: expect.any(Number),
      userId: 'agent:persona-test',
      brain: 'scripted',
      backend: 'real',
      recordedAt: '2026-09-14T00:00:00.000Z',
    });
  });
});
