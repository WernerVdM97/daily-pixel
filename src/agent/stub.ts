#!/usr/bin/env node
/**
 * The stub-backed deterministic agent-player run — `npm run agent:stub -- <days> [--inherit]` — plays the harness
 * loop with the SCRIPTED brain against `StubBackend` (see `src/protocol/stubBackend.ts`); its transcript is the replay corpus. Env: `.pi/skills/agent-smoke/SKILL.md`.
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinClock } from './clock.js';
import { pathToFileURL } from 'node:url';

import { createAgentHarness, type AgentHarness, type DaySummary } from './harness.js';
import { ScriptedAgentPlayerGateway } from './ScriptedAgentPlayerGateway.js';
import { GameRouter } from '../protocol/router.js';
import {
  StubBackend,
  SEPARATOR,
  decisionView,
  noticeView,
  STUB_STEP_OUTCOME,
  stubChar,
  wizardStep8View,
  wizardStepNView,
} from '../protocol/stubBackend.js';
import type { AgentObserver, CharacterData, CharCreateData } from './observer.js';
import type { AgentMove } from './AgentPlayerGateway.js';
import type { StepChoiceResult, WizardOptionResult } from '../controller/SessionController.js';
import type { MenuViewState, NoticeViewState } from '../view/viewState.js';

/** The session id the stub run plays as. The stub ignores it (its character is not keyed by userId),
 *  but the protocol header must be honest, and a stable id is fine. */
const DEFAULT_USER_ID = 'agent:stub';

/** The canned full-lifecycle character (the fresh arm): the real first-option def values the wizard
 *  validates against, the same profile the contract suite and the harness tests use. */
const CHAR_DATA: CharCreateData = {
  name: 'Rowan',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  // The wizard persists step-5 values lowercase and validates against the defs.
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  // Step 7 (Starting Kit) is MANDATORY — the walk can't reach the confirm without it.
  itemSetName: "Soldier's Kit",
};

/** The day-job action menu — one day-job button (index 0) + the Custom… slot, the contract suite's
 *  canonical menu shape (its fixture stays local there; this is the runner's copy). */
const MENU_VIEW: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Town Guard — Daily Work' },
  description: 'Pick a task to start:',
  buttons: [
    { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'secondary' },
    { label: 'Custom…', customId: 'action:dayjob:custom', style: 'primary' },
  ],
};

/** The stub's character.create created arm. The walk checks only the envelope's `ok`, so this view is
 *  presentation-only copy — no code reads its text. */
const CREATED_VIEW: NoticeViewState = {
  screen: 'notice',
  text: [
    "📍 **The Warden's Oak** — Use `look` for the full scene.",
    '',
    `⚔️  **${CHAR_DATA.name}** — ${CHAR_DATA.class}`,
    SEPARATOR,
    '',
    `🛡️ **${CHAR_DATA.dayJob} — Daily Work**`,
    '',
    '📦 Press the **Action** button to start.',
  ].join('\n'),
  ephemeral: true,
};

/** One day of the scripted brain: the day-job flow (menu-pick 0 → choice ×2 → outcome), then the
 *  custom-action flow (custom → choice ×2 → outcome), then sleep — exactly the moves the canned stub consumes. */
const DAY_MOVES: AgentMove[] = [
  { kind: 'menu-pick', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'custom', text: 'Scout the ridgeline' },
  { kind: 'choice', index: 0 },
  { kind: 'choice', index: 0 },
  { kind: 'sleep' },
];

/** The canned full-lifecycle script's two stateful bits, layered over the contract `StubBackend` (the base
 *  stays untouched). Wizard chooses walk step N → N+1; decision views alternate — the base's static fields cannot. */
export class CannedStubBackend extends StubBackend {
  private chooseBeats = 0;

  override chooseWizardOption(_userId: string, step: number, _value: string): WizardOptionResult {
    this.calls.push('chooseWizardOption');
    // Choosing step N advances the wizard to step N+1 (the real controller's progression), so the
    // response view mirrors what a real walk would return after each choose.
    return { kind: 'view', view: this.wizardViews[step + 1] ?? wizardStepNView(step + 1) };
  }

  override async stepChoice(_userId: string, _label: string, _prevChar: CharacterData): Promise<StepChoiceResult> {
    this.calls.push('stepChoice');
    this.chooseBeats++;
    // Odd calls continue the deliberation (the loop asks the brain again); even calls resolve.
    return this.chooseBeats % 2 === 1 ? { kind: 'decision', view: decisionView } : STUB_STEP_OUTCOME;
  }
}

/** The observer adapter: a stateful AgentObserver over the stub backend. `getMeta`/`tick` are not part
 *  of the RouterBackend double, so the harness reads the day label and the nightly cron through here. */
class StubObserver implements AgentObserver {
  private current = 1;

  constructor(private readonly backend: StubBackend) {}

  getCharacter(_userId: string): CharacterData | null {
    return this.backend.character;
  }

  getMeta(_key: 'day_number'): string | null {
    return String(this.current);
  }

  tick(_admin: true): { dayNumber: number } {
    return { dayNumber: ++this.current };
  }
}

/** Wire the canned full-lifecycle script onto a fresh backend instance — the static half, the two stateful
 *  alternations living in `CannedStubBackend`. Exported for the replay runner's fresh-backend rebuild. */
export function configureCannedScript(backend: StubBackend): void {
  // Day loop: the day-job start and the custom slot both open the decision flow, which
  // resolves through TWO action.choose beats (see CannedStubBackend.stepChoice).
  backend.menuResult = { kind: 'menu', view: MENU_VIEW };
  backend.dayJobResult = {
    kind: 'ok',
    workplace: 'The Town Gate',
    workPrompt: 'Walk the rounds — the wall is quiet tonight.',
    wage: 5,
  };
  backend.commuteResult = { kind: 'none' };
  backend.workResult = { kind: 'decision', view: decisionView };
  backend.customResult = { kind: 'start' };
  backend.customWorkResult = { kind: 'decision', view: decisionView };
  backend.choiceResult = { kind: 'ok', character: stubChar };
  backend.resolveResult = 'Advance carefully';

  // Safe at the Oak (alreadyThere, no unsafe), so sleep ends the day cleanly with no unsafe-rest
  // finding — the contract suite's RESTED_SAFE, rebuilt here (it stayed local there).
  backend.restResult = {
    kind: 'rested',
    alreadyThere: true,
    prev: { health: 10, stamina: 10 },
    updated: stubChar,
    wasUnsafe: false,
    unsafeFromName: "The Warden's Oak",
  };

  // REAL views so the beats succeed (the stub's no-character defaults would make them silent);
  // hi.open's greeting arm fires the semantic greeting event.
  backend.hiResult = { kind: 'greeting', view: noticeView };
  backend.lookResult = { kind: 'view', view: noticeView };
  backend.statsResult = { kind: 'view', view: noticeView };

  // The fresh creation walk: successive step views + the created arm.
  backend.wizardViews = {
    2: wizardStepNView(2),
    3: wizardStepNView(3),
    4: wizardStepNView(4),
    5: wizardStepNView(5),
    6: wizardStepNView(6),
    7: wizardStepNView(7),
    8: wizardStep8View,
  };
  backend.answerResult = { kind: 'view', view: wizardStepNView(2) };
  backend.confirmResult = { kind: 'created', view: CREATED_VIEW, created: CHAR_DATA };
}

/** The canned run's recording clock — a Wednesday, so the greeting and the tick's weekday branches stay on
 *  the weekday side. Fixed rather than `now`: the committed corpus is deep-equalled against a fresh run. */
export const STUB_RECORDED_AT = '2026-07-15T09:00:00.000Z';

export interface StubRunOptions {
  /** The inherit arm: no creation walk — the session starts at menu.open as the player. */
  inherit?: boolean;
  outPath?: string;
  protocolOut?: string;
  /** Override the recording clock stamped into the protocol-log header. */
  recordedAt?: string;
}

export interface StubRunResult {
  harness: AgentHarness;
  summaries: DaySummary[];
  outPath: string;
  protocolOut: string;
  backend: StubBackend;
}

/** Run the stub-backed scripted session in-process (the dogfood test drives this). Both files land in
 *  `finally`, as in `play.ts`, and the protocol log deep-equals across fresh runs. */
export async function stubRun(days: number, opts: StubRunOptions = {}): Promise<StubRunResult> {
  // The RECORD half: the header stamps a fixed clock, so the run must execute on that clock or the
  // recording and its replay disagree on every weekday branch.
  const restoreClock = pinClock(opts.recordedAt ?? STUB_RECORDED_AT);
  try {
    return await stubRunPinned(days, opts);
  } finally {
    restoreClock();
  }
}

async function stubRunPinned(days: number, opts: StubRunOptions = {}): Promise<StubRunResult> {
  const outPath = opts.outPath ?? process.env.AGENT_OUT ?? path.join(os.tmpdir(), `agent-stub-${Date.now()}.json`);
  const protocolOut = opts.protocolOut ?? process.env.AGENT_PROTOCOL_OUT ?? `${outPath}.protocol.json`;

  const backend = new CannedStubBackend();
  configureCannedScript(backend);
  const brain = new ScriptedAgentPlayerGateway(Array.from({ length: days }, () => DAY_MOVES).flat());
  const router = new GameRouter(backend, { idle: () => '' });
  // The header is honest: scripted brain + stub backend class (replay's selector), and the
  // AGENT_PROTOCOL_BEATS knob read here in the runner, like play.ts (the library stays env-free).
  const harness = createAgentHarness(new StubObserver(backend), router, brain, DEFAULT_USER_ID, {
    brain: 'scripted',
    backend: 'stub',
    // Fixed by default, not `now`: the run's whole value is byte-reproducibility, and a wall-clock stamp
    // would make every fresh run differ from the committed corpus. Overridable to pick another weekday.
    recordedAt: opts.recordedAt ?? STUB_RECORDED_AT,
    ...(process.env.AGENT_PROTOCOL_BEATS === '1' ? { recordBeats: true } : {}),
  });

  let summaries: DaySummary[] = [];
  try {
    if (!opts.inherit) {
      // The full join wizard walk through the harness's recorded dispatch (any ok:false throws —
      // the fresh arm must reach the created state for the run to play).
      await harness.createCharacter(CHAR_DATA);
    }
    summaries = await harness.playDays(days);
  } finally {
    writeFileSync(outPath, JSON.stringify(harness.transcript.events, null, 2));
    writeFileSync(protocolOut, JSON.stringify(harness.transcript.protocol, null, 2));
  }

  return { harness, summaries, outPath, protocolOut, backend };
}

function parseArgs(argv: string[]): { days: number | undefined; inherit: boolean; error?: string } {
  let days: number | undefined;
  let inherit = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg === '--inherit') {
      inherit = true;
    } else if (arg.startsWith('-')) {
      return { days: undefined, inherit: false, error: `unknown flag "${arg}"` };
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    return { days: undefined, inherit: false, error: `unexpected argument "${positionals[1]}"` };
  }
  if (positionals.length === 1) days = Number(positionals[0]);
  return { days, inherit };
}

async function main(): Promise<void> {
  const { days, inherit, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(`agent:stub: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (days === undefined || !Number.isInteger(days) || days < 1) {
    console.error(`agent:stub: <days> must be a positive integer (got "${process.argv.slice(2).find((a) => !a.startsWith('-')) ?? ''}").`);
    process.exitCode = 1;
    return;
  }

  const outPath = process.env.AGENT_OUT ?? path.join(os.tmpdir(), `agent-stub-${Date.now()}.json`);
  const protocolOut = process.env.AGENT_PROTOCOL_OUT ?? `${outPath}.protocol.json`;

  const { harness, summaries } = await stubRun(days, { inherit, outPath, protocolOut });

  if (inherit) {
    console.error(`Inheriting ${DEFAULT_USER_ID} — playing ${days} day(s)…\n`);
  } else {
    console.error(`Seeded ${CHAR_DATA.name} (${CHAR_DATA.class}) — playing ${days} day(s)…\n`);
  }

  // Everything human-readable → stderr (the semantic + protocol files stay clean JSON).
  console.error(`\n── transcript written to ${outPath} ──`);
  console.error(`── protocol log written to ${protocolOut} ──`);
  console.error('\n── day summaries ──');
  for (const s of summaries) {
    console.error(`  day ${s.dayNumber}: ${s.outcomes} outcome(s), ended ${s.ended}`);
  }
  const run = harness.transcript.summary();
  console.error(
    `\n── run summary ──\n  ${run.turns} turns, ${run.outcomes} outcomes, ${run.deadEnds} dead-ends, ` +
      `${run.commutes} commutes, ${run.greetings} greeting(s), ${run.dayBoundaries} nights\n  findings: ${run.findings.error} error(s), ` +
      `${run.findings.warning} warning(s)`,
  );

  // The inherit-mode asymmetry (the play.ts convention): the stub always has a character,
  // so a no-character inherit day means the script broke — surface it as a non-zero exit.
  if (inherit && summaries.some((s) => s.ended === 'no-character')) {
    console.error(`agent:stub: no character found for ${DEFAULT_USER_ID} (inherit arm) — nothing played (exit 1).`);
    process.exitCode = 1;
  }
}

// Run only when executed directly (npm run agent:stub) — importing the module in-process (the stub test,
// the corpus dogfood) must not trigger the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
