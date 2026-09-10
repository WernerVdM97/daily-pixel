import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameRouter, type RouterBackend } from '../../src/protocol/router.js';
import { resetCache } from '../../src/protocol/profanity.js';
import { PROTOCOL_VERSION, validateGameResponse, type GameErrorCode, type GameResponse } from '../../src/protocol/envelope.js';
import { SessionController } from '../../src/controller/SessionController.js';
import type { HiOpenResult, RestBeginResult, StartRenderResult, StepChoiceResult, WizardConfirmResult } from '../../src/controller/SessionController.js';
import { MockWorldEngine } from '../../src/engine/MockWorldEngine.js';
import type { ActionOutcome, CharCreateData } from '../../src/engine/WorldEngine.js';
import { getDayJobActions, type DayJobDef } from '../../src/controller/dayJob.js';
import type { DecisionViewState, MenuViewState, NoticeViewState, ViewState, WizardViewState } from '../../src/view/viewState.js';
import { loadYamlFile } from '../../src/assets/yaml-loader.js';
import { WizardSession } from '../../src/controller/WizardSession.js';
import type { CharDefs } from '../../src/controller/joinWizard.js';
import {
  StubBackend,
  SEPARATOR,
  decisionView,
  noticeView,
  stubChar,
  SCREEN_VIEWS,
  wizardStepNView,
  wizardStep8View,
  HI_RESUME,
  STUB_OUTCOME,
  STUB_STEP_OUTCOME,
} from '../../src/protocol/stubBackend.js';
import { stubRun } from '../../src/agent/stub.js';
import { replayLog } from '../../src/agent/replay.js';
import type { ProtocolDispatchEntry, ProtocolEntry } from '../../src/agent/transcript.js';

// ── M5.1 — the contract-test barrier (see docs/engine/json-seam-protocol.md § "M5 build
// plan", slice M5.1, and § "The contract-test barrier"). Every event × every reachable
// branch drives BOTH the real backend (SessionController + MockWorldEngine, the
// session-controller test wiring) and a canned stub RouterBackend (DC-P7), so
// interchangeability is asserted, not reviewed. Every emitted envelope — final AND each
// beat — is run through validateGameResponse (conformance), every view must survive
// JSON.parse(JSON.stringify()) unchanged (round-trip), and decision/menu button-element
// shape is asserted per Execution-state settle (2) because the envelope validator checks
// views shallowly on purpose. No network, fully deterministic: idle is a fixed string. ──

const USER = 'user-1';
const IDLE = 'The wind stirs the leaves.';
const SCENE = 'A quiet clearing under the oak.';

// ── Canonical copy expectations (DC-P4) — hard-coded here, not imported from the router,
// so the suite is the net that catches copy drift. ──

const NO_CHARACTER_MENU_COPY = "You don't have a character yet. Type `/join` to create one.";
const NO_CHARACTER_COPY = "You don't have a character. Type `/join` first.";
const NO_ROLLS_COPY = '🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.';
const INVALID_JOB_COPY = 'Invalid job action.';
const SESSION_EXPIRED_COPY = "❌ Your action session expired. Try `/action` again.";
const UNSAFE_COPY = (location: string): string =>
  `⚠️ **It's no place for honest work here.**\nThe ${location} is too dangerous — make for safer ground before you set to your trade.`;
// DC-M9.3.8: the profanity guard's own copy, moved into the router with the guard.
const PROFANITY_COPY = "❌ That action contains language the warden won't tolerate. Try something else.";

// ── rest.begin copy (DC-M7.1.3) — the guard copies + the rest screen are byte-for-byte
// lifts of the old sleep.ts reply assembly; M7.0 bookend-oracle transcripts 12/14 and the
// M1 oracle's /sleep leaves pin them. ──

const MID_ACTION_COPY = [
  '⛔ **Cannot rest now**',
  SEPARATOR,
  '',
  'You are mid-action — finish what you started before bedding down.',
  '',
  'Use `/action continue` to resume, or let it time out after 30 minutes.',
].join('\n');

const ROLLS_REMAINING_COPY = [
  '⛔ **Cannot rest now**',
  SEPARATOR,
  '',
  'The day is still young — you have actions left to take.',
  'Spend your remaining rolls before bedding down beneath the Oak.',
].join('\n');

// ── character.create flow copy (DC-M7.3.6) — hard-coded here, not imported from the
// router, so the suite is the net that catches copy drift. HAS_CHARACTER_COPY is
// byte-pinned by M7.0 bookend-oracle transcript 2; WIZARD_NO_SESSION_COPY by the new
// transcript 17; WIZARD_ILLEGAL_CHOICE_COPY by the new transcript 19. ──

const HAS_CHARACTER_COPY = "You already have a character. Type `/stats` to see it.";
const WIZARD_NO_SESSION_COPY = "Your character creation session expired. Type `/join` to start over.";
const WIZARD_ILLEGAL_CHOICE_COPY = "That option is no longer available. Type `/join` to start over.";
const WIZARD_NOT_READY_COPY = "Character creation isn't ready to confirm. Type `/join` to start over.";

// ── Real-backend fixtures ──

/** A minimal day-job roster: 'Town Guard' matches the default test character's dayJob so
 *  beginDayJob/composeActionMenu resolve real actions and a real workplace. */
const DAY_JOBS: DayJobDef[] = [
  {
    name: 'Town Guard',
    depends_on: [],
    base_income: 3,
    workplace_location: 'The Town Gate',
    description: 'Keep the gate.',
    actions: [
      { label: 'Walk the rounds', income: 5, hook: 'The wall is quiet tonight.' },
      { label: 'Patrol the walls', income: 4, hook: 'Watch for movement below.' },
    ],
  },
];

/** A fully-resolved outcome with FIXED literals so buildOutcomeView renders deterministically
 *  (same fixture pattern as the M1 golden-transcript oracle). */
const RESOLVED_OUTCOME: ActionOutcome = {
  distilledType: 'scout',
  finalDc: 11,
  playerRolled: 14,
  outcome: 'success',
  rollBonus: 3,
  rollStat: 'physical',
  mutations: [{ type: 'modify_stamina', amount: -1 }],
  outcomeText: 'You crest the ridge and chart the valley below.',
  actionId: 77,
};

/** startAction → auto-finish outcome (quest kind). */
const RESOLVED_START: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'scout the northern ridge', decisions: [], accumulatedDc: 11, kind: 'quest' },
  firstDecision: { prompt: '', options: [] },
  outcome: RESOLVED_OUTCOME,
  actionType: 'search',
};

/** startAction → auto-finish outcome (work kind, with wage — the day-job flow). */
const RESOLVED_WORK: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'Walk the rounds', decisions: [], accumulatedDc: 11, kind: 'work', wage: 5 },
  firstDecision: { prompt: '', options: [] },
  outcome: RESOLVED_OUTCOME,
  actionType: 'other',
};

/** startAction → stops on a first decision (work kind, for the day-job flow). */
const DECISION_WORK: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'Walk the rounds', decisions: [], accumulatedDc: 10, kind: 'work' },
  firstDecision: {
    prompt: 'The gate creaks. What do you do?',
    options: [
      { label: 'Advance carefully', dcModifier: 0, stat: 'physical' },
      { label: 'Charge ahead', dcModifier: 2 },
    ],
  },
  actionType: 'other',
};

// M9.1 (DC-M9.3) — a refunded divine-intervention roll: no mutations, no actionId written
// (the engine never persists an action row on this path).
const DIVINE_TEXT = 'The warden intervenes — your roll is refunded.';

/** startAction → refunded divine intervention (work kind, day-job flow). */
const DIVINE_WORK: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'Walk the rounds', decisions: [], accumulatedDc: 11, kind: 'work', wage: 5 },
  firstDecision: { prompt: '', options: [] },
  outcome: { ...RESOLVED_OUTCOME, actionId: undefined, mutations: [], outcomeText: DIVINE_TEXT, isDivineIntervention: true },
  actionType: 'other',
};

/** startAction → refunded divine intervention (quest kind, custom-action flow). */
const DIVINE_START: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 11, kind: 'quest' },
  firstDecision: { prompt: '', options: [] },
  outcome: { ...RESOLVED_OUTCOME, actionId: undefined, mutations: [], outcomeText: DIVINE_TEXT, isDivineIntervention: true },
  actionType: 'search',
};

/** startAction → stops on a first decision (quest kind, for the custom-action flow). */
const DECISION_QUEST: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
  firstDecision: {
    prompt: 'The gate creaks. What do you do?',
    options: [
      { label: 'Advance carefully', dcModifier: 0 },
      { label: 'Charge ahead', dcModifier: 2 },
    ],
  },
  actionType: 'other',
};

/** startAction → stops on a first decision, combat-classified, with a named enemy and a
 *  banded re-entry condition (DC-M9.2.2's threading proof — see the standalone test below). */
const DECISION_COMBAT: Parameters<MockWorldEngine['setStartActionResult']>[0] = {
  state: { rawInput: 'confront the boar', decisions: [], accumulatedDc: 10, kind: 'quest' },
  firstDecision: {
    prompt: 'The boar snarls and lowers its tusks. What do you do?',
    options: [
      { label: 'Strike first', dcModifier: 0 },
      { label: 'Hold your ground', dcModifier: 1 },
    ],
  },
  actionType: 'combat',
  combatEnemyName: 'Ironback Boar',
  combatEnemyCondition: { woundWord: 'Bloodied', filled: 3, total: 5 },
};

/** stepAction → a continue-decision beat. */
const NEXT_DECISION_STEP: Parameters<MockWorldEngine['setStepActionResult']>[0] = {
  resolved: false,
  state: { rawInput: 'Walk the rounds', decisions: [], accumulatedDc: 11 },
  nextDecision: {
    prompt: 'A shadow shifts ahead. Press on?',
    options: [
      { label: 'Push forward', dcModifier: 1 },
      { label: 'Fall back', dcModifier: null },
    ],
  },
};

/** stepAction → resolved straight to an outcome. */
const RESOLVED_STEP: Parameters<MockWorldEngine['setStepActionResult']>[0] = {
  resolved: true,
  state: {
    rawInput: 'Walk the rounds',
    decisions: [
      {
        prompt: 'The gate creaks. What do you do?',
        options: [],
        chosen: 'Advance carefully',
        dcModifier: 0,
        distilledType: 'scout',
      },
    ],
    accumulatedDc: 11,
  },
  outcome: RESOLVED_OUTCOME,
};

/** The pending-decision option list resolvePendingChoice resolves against — the real
 *  engine's last_action_state.pendingDecision.options (M3.2 DC-F). */
const PENDING_OPTIONS = [
  { label: 'Advance carefully', dcModifier: 0, stat: 'physical' },
  { label: 'Fall back', dcModifier: null },
];

/** A truthy-but-minimal in-flight action state — the controller only truthiness-checks it. */
const IN_FLIGHT = { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' };

// ── Canonical views for the stub backend (all must pass validateGameResponse — the
// router's own self-validation would drop them otherwise). ──

const menuView: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Town Guard — Daily Work' },
  description: 'Pick a task to start:',
  buttons: [
    { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'secondary' },
    { label: 'Custom…', customId: 'action:dayjob:custom', style: 'primary' },
  ],
};

// ── M8.1 screens (DC-M8.3/4) — fixtures for the six screen.* events. The stub's view arms
// are canned notice texts observably equivalent to the real compositions (screen
// discriminator + facts + the no-character copy are what the shared asserts pin; the
// byte-identity of the full screen text is the screens oracle's job, not the contract
// suite's). SCENE_STUB is the controller's 7th constructor arg at the test construction
// sites — a fixed scene-renderer (the dispatch-harness stub pattern, DC-M8.5). ──

const SCENE_STUB = () => ({ sceneName: 'test', ascii: '...' });

// ── M7.3 wizard fixtures (DC-M7.3.11) — canonical views for the stub backend + the real
// wizard conformance. Step 1 has nameField + a name button; steps 2-7 carry non-empty
// options + choice buttons + a restart; step 8 confirm + restart. ──

const WIZARD_SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** The stub's character.create created arm — a canned hi greeting observably equivalent to
 *  the real backend's post-confirm compose (both carry the Oak location line + the daily
 *  work block + the seed-era header), plus the exact CharCreateData the shared assert pins. */
const CREATED_DATA: CharCreateData = {
  name: 'Rowan',
  class: 'Warrior',
  upbringing: 'Soldier',
  race: 'Human',
  alignment: 'lawful good',
  dayJob: 'Town Guard',
  itemSetName: "Soldier's Kit",
};

const CREATED_HI: NoticeViewState = {
  screen: 'notice',
  text: [
    "📍 **The Warden's Oak** — Use `look` for the full scene.",
    '',
    '⚔️  **Rowan** — Warrior',
    WIZARD_SEPARATOR,
    '',
    '❤️ 10/10  ┃  ⚡ 10/10  ┃  🎲 3  ┃  💰 5',
    '',
    '🛡️ **Town Guard — Town Square — Daily Work**',
    '',
    '📦 Press the **Action** button or type `action <what you do>` to start.',
  ].join('\n'),
  ephemeral: true,
};

const WIZARD_CREATED: WizardConfirmResult = { kind: 'created', view: CREATED_HI, created: CREATED_DATA };

/** Real char-creation defs (DC-M7.3.10) — the controller's wizard renders from the same
 *  YAMLs main() loads, mirroring the DAY_JOBS load. */
const CC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'char-creation');
function loadDefs<T>(file: string): T[] {
  return loadYamlFile(path.join(CC_DIR, file)) as T[];
}
const REAL_DEFS: CharDefs = {
  classes: loadDefs('classes.yml'),
  backgrounds: loadDefs('backgrounds.yml'),
  races: loadDefs('races.yml'),
  alignments: loadDefs('alignments.yml'),
  dayJobs: loadDefs('day-jobs.yml'),
  itemSets: loadDefs('item-sets.yml'),
};

/** The stub's rest.begin rested arm — safe at the Oak. */
const RESTED_SAFE: RestBeginResult = {
  kind: 'rested',
  alreadyThere: true,
  prev: { health: 10, stamina: 10 },
  updated: stubChar,
  wasUnsafe: false,
  unsafeFromName: "The Warden's Oak",
};

/** The stub's rest.begin rested arm — unsafe, so the penalty fired (10 → 7 HP shown here
 *  is the stub's own fixture; the real backend clamps through modifyHealth). */
const RESTED_UNSAFE: RestBeginResult = {
  kind: 'rested',
  alreadyThere: false,
  prev: { health: 8, stamina: 10 },
  updated: { ...stubChar, health: 7, location: "The Warden's Oak" },
  wasUnsafe: true,
  unsafeFromName: 'The Broken Keep',
};

/** The seeded action labels the /hi day-job block renders for the default character on
 *  day 1 — computed exactly the way composeHiScreen computes them (same day-job, same
 *  characterId/dayNumber seed), so the stub's greeting fixture and the real backend's
 *  greeting text are observably equivalent (the interchangeability point). */
const HI_SEEDED_LABELS = getDayJobActions('Town Guard', DAY_JOBS, { characterId: 1, dayNumber: 1 }).map((a) => a.label);

/** The stub's hi.open weekday-greeting arm — the action lines are built FROM the seeded
 *  labels, so the shared conformance assert proves real/stub equivalence label by label. */
const HI_GREETING: HiOpenResult = {
  kind: 'greeting',
  view: {
    screen: 'notice',
    text: [
      "📍 **The Warden's Oak** — Use `look` for the full scene.",
      '',
      '🔹  **Aldric** — Warrior',
      SEPARATOR,
      '',
      '🔨 **Town Guard — The Town Gate — Daily Work**',
      '',
      ...HI_SEEDED_LABELS.map((label, i) => `  ${['🎯', '🔧', '📋'][i]} **${label}** — ${label.toLowerCase()} hook`),
      '',
      '📦 Press the **Action** button or type `action <what you do>` to start.',
    ].join('\n'),
    ephemeral: true,
  },
};

// ── Router factories ──

function realRouter(engine: MockWorldEngine, wizards?: WizardSession): GameRouter {
  // The assignment is the runtime-side structural proof (DC-P7): SessionController must
  // satisfy RouterBackend or this line fails to compile. The typecheck-time proof lives
  // in src/protocol/router.ts (exported `SessionControllerSatisfiesRouterBackend`).
  // M7.3 (DC-M7.3.10): the controller owns the wizard store + defs; a per-call fresh store
  // unless the caller seeds one (the wizard conformance cases pass their own).
  const backend: RouterBackend = new SessionController(
    engine,
    () => SCENE,
    DAY_JOBS,
    undefined,
    wizards ?? new WizardSession(),
    REAL_DEFS,
    SCENE_STUB,
  );
  return new GameRouter(backend, { idle: () => IDLE });
}

function stubRouter(configure?: (stub: StubBackend) => void): GameRouter {
  const stub = new StubBackend();
  configure?.(stub);
  return new GameRouter(stub, { idle: () => IDLE });
}

function realChar(overrides?: Parameters<typeof MockWorldEngine.defaultCharacter>[0]): MockWorldEngine {
  const engine = new MockWorldEngine();
  engine.setCharacter(MockWorldEngine.defaultCharacter({ dayJob: 'Town Guard', ...overrides }));
  return engine;
}

// ── Conformance harness ──

interface DispatchOutcome {
  response: GameResponse;
  beats: GameResponse[];
}

/** Dispatch, then assert the barrier: final + every beat validate, every view round-trips,
 *  and decision/menu button elements carry their required shape (Execution-state settle 2). */
async function drive(router: GameRouter, event: unknown): Promise<DispatchOutcome> {
  const beats: GameResponse[] = [];
  const response = assertValid(await router.dispatch(event, (beat) => beats.push(beat)));
  for (const beat of beats) assertValid(beat);
  assertViewConformance(response);
  for (const beat of beats) assertViewConformance(beat);
  assertFactsRoundTrip(response);
  return { response, beats };
}

function assertValid(raw: unknown): GameResponse {
  const check = validateGameResponse(raw);
  if (!check.ok) throw new Error(`envelope failed validation: ${check.message}`);
  expect(check.response.v).toBe(PROTOCOL_VERSION);
  return check.response;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function okView(beat: GameResponse): ViewState | undefined {
  return beat.ok ? beat.view : undefined;
}

function beatScreens(beats: GameResponse[]): Array<string | undefined> {
  return beats.map((b) => (b.ok ? b.view?.screen : undefined));
}

/** Both error and view envelopes can carry `facts` (error narration, character snapshots) —
 *  they must survive the JSON seam like views do (round-trip c). */
function assertFactsRoundTrip(response: GameResponse): void {
  if (response.facts === undefined) return;
  expect(roundTrip(response.facts)).toEqual(response.facts);
}

function assertViewConformance(response: GameResponse): void {
  if (!response.ok || response.view === undefined) return;
  // Round-trip (c): the seam is JSON even in-process.
  expect(roundTrip(response.view)).toEqual(response.view);
  switch (response.view.screen) {
    case 'decision':
      assertDecisionButtons(response.view.buttons);
      break;
    case 'menu':
      assertMenuButtons(response.view.buttons);
      break;
    default:
      break;
  }
}

/** Execution-state settle (2): decision button elements are lettered choices or worded bails. */
function assertDecisionButtons(buttons: DecisionViewState['buttons']): void {
  for (const b of buttons) {
    if (b.kind === 'choice') {
      expect(typeof b.letter).toBe('string');
      expect(typeof b.customId).toBe('string');
      expect(typeof b.favoured).toBe('boolean');
    } else {
      expect(typeof b.label).toBe('string');
      expect(typeof b.customId).toBe('string');
    }
  }
}

/** Execution-state settle (2): menu buttons carry the exact three fields composeActionMenu emits. */
function assertMenuButtons(buttons: MenuViewState['buttons']): void {
  for (const b of buttons) {
    expect(typeof b.label).toBe('string');
    expect(typeof b.customId).toBe('string');
    expect(b.style === 'secondary' || b.style === 'primary').toBe(true);
  }
}

function expectError(response: GameResponse, code: GameErrorCode, message: string): void {
  if (response.ok) throw new Error(`expected ok:false ${code}, got ok:true`);
  expect(response.error.code).toBe(code);
  expect(response.error.message).toBe(message);
}

function expectInternal(response: GameResponse): void {
  if (response.ok) throw new Error('expected ok:false internal, got ok:true');
  expect(response.error.code).toBe('internal');
  expect(response.error.message.length).toBeGreaterThan(0);
}

function expectOkView(response: GameResponse, screen: ViewState['screen']): ViewState {
  if (!response.ok) throw new Error(`expected ok:true, got ${response.error.code}: ${response.error.message}`);
  expect(response.view?.screen).toBe(screen);
  return response.view as ViewState;
}

function errorCodeOf(o: DispatchOutcome): GameErrorCode {
  if (o.response.ok) throw new Error('expected an error envelope, got ok:true');
  return o.response.error.code;
}

// ── The case tables: every event × every reachable branch, driven against BOTH backends
// with ONE shared expectation (the stub is scripted to produce observably equivalent
// envelopes — that equivalence IS the interchangeability proof). ──

interface BackendCase {
  name: string;
  event: unknown;
  real: () => GameRouter;
  stub: () => GameRouter;
  assert: (o: DispatchOutcome) => void;
}

function runCaseBlock(title: string, cases: BackendCase[]): void {
  describe(title, () => {
    for (const c of cases) {
      it(`${c.name} — real backend`, async () => c.assert(await drive(c.real(), c.event)));
      it(`${c.name} — stub backend`, async () => c.assert(await drive(c.stub(), c.event)));
    }
  });
}

const MENU_OPEN = { type: 'menu.open' as const, playerId: USER };
const DAYJOB_START = (jobIndex: number): unknown => ({ type: 'dayjob.start', playerId: USER, jobIndex });
const ACTION_CUSTOM = { type: 'action.custom' as const, playerId: USER, text: 'scout the ridge' };
const ACTION_CHOOSE = { type: 'action.choose' as const, playerId: USER, selector: { kind: 'option', index: 0 } };
const ACTION_BAIL = { type: 'action.choose' as const, playerId: USER, selector: { kind: 'bail' } };
const FEEDBACK = (surface: string, actionId?: number): unknown => ({ type: 'feedback.submit', playerId: USER, surface, text: 'loving the atmosphere', actionId });
const BUG = (actionId?: number): unknown => ({ type: 'bug.submit', playerId: USER, text: 'the door is stuck', actionId });
// M9.1 (DC-M9.5): bug.submit's optional surface — 'slash-bug' rides the same event shape.
const BUG_SURFACE = (surface: string, actionId?: number): unknown => ({ type: 'bug.submit', playerId: USER, surface, text: 'the door is stuck', actionId });
const REST_BEGIN = { type: 'rest.begin' as const, playerId: USER };
const HI_OPEN = { type: 'hi.open' as const, playerId: USER };
const JOIN_OPEN = { type: 'join.open' as const, playerId: USER };
const WIZARD_ANSWER = { type: 'wizard.answer' as const, playerId: USER, text: 'Rowan' };
const WIZARD_CHOOSE = (step: number, value: string): unknown => ({ type: 'wizard.choose', playerId: USER, step, value });
const WIZARD_RESTART = { type: 'wizard.restart' as const, playerId: USER };
const CHARACTER_CREATE = { type: 'character.create' as const, playerId: USER };

// ── M8.1 screens (DC-M8.1) — the six flat screen.* events. SCREEN_MAP carries the
// optional slash-arm focus (absent → the full map). ──

const SCREEN_LOOK = { type: 'screen.look' as const, playerId: USER };
const SCREEN_MAP = (focus?: string): unknown => ({ type: 'screen.map', playerId: USER, ...(focus !== undefined ? { focus } : {}) });
const SCREEN_STATS = { type: 'screen.stats' as const, playerId: USER };
const SCREEN_BACKPACK = { type: 'screen.backpack' as const, playerId: USER };
const SCREEN_JOURNAL = { type: 'screen.journal' as const, playerId: USER };
const SCREEN_HELP = { type: 'screen.help' as const, playerId: USER };

// ── rest.begin (M7.1, DC-M7.1.3: no-character → guards → rested notice view; NO beats) ──

runCaseBlock('conformance — rest.begin', [
  {
    name: 'no-character → no-character with the other-events copy (the gate reroutes gated commands, recorded unification)',
    event: REST_BEGIN,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'mid-action → illegal-move with the ⛔ cannot-rest-now copy',
    event: REST_BEGIN,
    real: () => realRouter(realChar({ rollsRemaining: 0, lastActionState: IN_FLIGHT as never })),
    stub: () => stubRouter((s) => { s.restResult = { kind: 'mid-action' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', MID_ACTION_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'rolls remaining → illegal-move with the day-is-still-young copy',
    event: REST_BEGIN,
    real: () => realRouter(realChar({ rollsRemaining: 1 })),
    stub: () => stubRouter((s) => { s.restResult = { kind: 'rolls-remaining' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', ROLLS_REMAINING_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'safe rest at the Oak → ok:true notice view, characterState/nav/characterName facts, NO restUnsafe, zero beats',
    event: REST_BEGIN,
    real: () => realRouter(realChar({ rollsRemaining: 0 })),
    stub: () => stubRouter((s) => { s.restResult = RESTED_SAFE; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toContain("The Oak's familiar boughs cradle you once more.");
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.restUnsafe).toBeUndefined();
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
      expect(o.response.facts?.nav).toMatchObject({ rollsRemaining: expect.any(Number), hasPendingAction: false, hasRestedToday: false });
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'unsafe rest → ⚠️ penalty section in the view text + the restUnsafe fact shape, zero beats',
    event: REST_BEGIN,
    real: () => {
      const engine = realChar({ rollsRemaining: 0, location: 'The Broken Keep', health: 8, maxHealth: 10 });
      engine.setLocation({ name: 'The Broken Keep', description: 'Ruins.', tags: ['ruins'], isSafe: false, emoji: '🏚️' });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.restResult = RESTED_UNSAFE; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toContain('⚠️ **Resting on unsafe ground costs 1 HP.**');
      expect((view as NoticeViewState).text).toContain('You bedded down at **The Broken Keep**');
      expect((view as NoticeViewState).text).toContain('you lost **1 HP**. (7/10 ❤️)');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.restUnsafe).toEqual({
        name: 'Aldric',
        prev: { health: 8, stamina: 10 },
        updated: { health: 7, stamina: 10 },
      });
      expect(o.beats).toEqual([]);
    },
  },
]);

// ── hi.open (M7.2, DC-M7.2.3: no-character → greeting/resume notice view; NO beats) ──
// Fake timers pin the weekday branch (the real backend reads new Date() for the weekend
// hooks, mirroring the M7.0 bookend oracle's date control).

describe('conformance — hi.open (fake timers: Wednesday 2026-07-15)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-07-15T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  runCaseBlock('conformance — hi.open', [
    {
      name: 'no-character → no-character with NO_CHARACTER_COPY (the gate reroutes gated commands, recorded unification)',
      event: HI_OPEN,
      real: () => realRouter(new MockWorldEngine()),
      stub: () => stubRouter(),
      assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
    },
    {
      name: 'weekday greeting → ok:true notice view with the location line, character header, day-job block and every seeded action label; characterState/nav/characterName facts; zero beats',
      event: HI_OPEN,
      real: () => realRouter(realChar()),
      stub: () => stubRouter((s) => { s.hiResult = HI_GREETING; }),
      assert: (o) => {
        const view = expectOkView(o.response, 'notice') as NoticeViewState;
        expect(view.text).toContain('— Use `look` for the full scene.');
        expect(view.text).toContain('Warrior');
        expect(view.text).toContain('Daily Work');
        for (const label of HI_SEEDED_LABELS) expect(view.text).toContain(label);
        expect(view.text).not.toContain('Weekend');
        if (!o.response.ok) throw new Error('unreachable');
        expect(o.response.facts?.characterName).toBe('Aldric');
        expect(o.response.facts?.characterState).toMatchObject({
          health: expect.any(Number),
          maxHealth: expect.any(Number),
          stamina: expect.any(Number),
          maxStamina: expect.any(Number),
          wealth: expect.any(Number),
          location: expect.any(String),
        });
        expect(o.response.facts?.nav).toMatchObject({ rollsRemaining: expect.any(Number), hasPendingAction: false, hasRestedToday: false });
        expect(o.beats).toEqual([]);
      },
    },
    {
      name: 'unfinished action → ok:true notice view with the prompt + narration, facts present, zero beats',
      event: HI_OPEN,
      real: () => {
        const engine = realChar({ lastActionState: IN_FLIGHT as never });
        engine.setResumeResult({
          state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
          nextDecision: { prompt: 'The trail forks. Continue?', options: [], narration: 'You stand at the ridgeline, wind pulling at your cloak.' },
        });
        return realRouter(engine);
      },
      stub: () => stubRouter((s) => { s.hiResult = HI_RESUME; s.character = { ...stubChar, lastActionState: IN_FLIGHT as never }; }),
      assert: (o) => {
        const view = expectOkView(o.response, 'notice') as NoticeViewState;
        expect(view.text).toContain('The trail forks. Continue?');
        expect(view.text).toContain('You stand at the ridgeline, wind pulling at your cloak.');
        if (!o.response.ok) throw new Error('unreachable');
        expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
        expect(o.response.facts?.nav).toMatchObject({ rollsRemaining: expect.any(Number), hasPendingAction: true, hasRestedToday: false });
        expect(o.beats).toEqual([]);
      },
    },
  ]);
});

// ── character.create flow (M7.3, DC-M7.3.6/11): the five wizard events — join.open,
// wizard.answer, wizard.choose, wizard.restart, character.create. No beats on any of them;
// the wizard view arms carry NO facts (the walk's user has no character); the created arm
// returns the hi greeting with `{ createdCharacter, ...addCharacterFacts }`. ──

/** Shared structural asserts the stub fixtures satisfy identically to the real compositions
 *  (DC-M7.3.11): step 1 has nameField + a name button; steps 2-7 non-empty options + choice
 *  buttons + restart; step 8 confirm + restart. */
function assertWizardStep1(view: ViewState): void {
  const w = view as WizardViewState;
  expect(w.screen).toBe('wizard');
  expect(w.step).toBe(1);
  expect(w.totalSteps).toBe(7);
  expect(w.nameField).toMatchObject({ label: expect.any(String), placeholder: expect.any(String), minLength: 2, maxLength: 30 });
  expect(w.buttons.some(b => b.kind === 'name' && b.label.length > 0)).toBe(true);
  expect(w.buttons.some(b => b.kind === 'confirm')).toBe(false);
}

function assertWizardOptionStep(view: ViewState): void {
  const w = view as WizardViewState;
  expect(w.screen).toBe('wizard');
  expect(w.step).toBeGreaterThanOrEqual(2);
  expect(w.step).toBeLessThanOrEqual(7);
  expect(w.options?.length).toBeGreaterThan(0);
  const choices = w.buttons.filter(b => b.kind === 'choice');
  expect(choices.length).toBeGreaterThan(0);
  for (const c of choices) {
    if (c.kind === 'choice') {
      expect(c.step).toBe(w.step);
      expect(c.value.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  }
  expect(w.buttons.some(b => b.kind === 'restart')).toBe(true);
}

function assertWizardStep8(view: ViewState): void {
  const w = view as WizardViewState;
  expect(w.screen).toBe('wizard');
  expect(w.step).toBe(8);
  expect(w.buttons.some(b => b.kind === 'confirm')).toBe(true);
  expect(w.buttons.some(b => b.kind === 'restart')).toBe(true);
}

/** Seed a real wizard session up to the given step with REAL_DEFS-valid choices. */
function seedWizard(wizards: WizardSession, userId: string, step: number): void {
  wizards.start(userId);
  wizards.setName(userId, 'Rowan');
  if (step > 2) wizards.choose(userId, 2, 'class', 'Warrior');
  if (step > 3) wizards.choose(userId, 3, 'upbringing', 'Soldier');
  if (step > 4) wizards.choose(userId, 4, 'race', 'Human');
  if (step > 5) wizards.choose(userId, 5, 'alignment', 'lawful good');
  if (step > 6) wizards.choose(userId, 6, 'dayJob', 'Town Guard');
  if (step > 7) wizards.choose(userId, 7, 'itemSet', "Soldier's Kit");
}

runCaseBlock('conformance — join.open', [
  {
    name: 'has-character → illegal-move with HAS_CHARACTER_COPY (byte-pinned by M7.0 transcript 2), no beats',
    event: JOIN_OPEN,
    real: () => {
      const engine = realChar();
      engine.setCharacterExists(true);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.joinResult = { kind: 'has-character' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', HAS_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'view → ok:true wizard step-1 view (nameField + name button), NO facts, zero beats',
    event: JOIN_OPEN,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => {
      const view = expectOkView(o.response, 'wizard');
      assertWizardStep1(view);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — wizard.answer', [
  {
    name: 'no-session → session-expired with WIZARD_NO_SESSION_COPY (the new TTL copy, pinned by transcript 17)',
    event: WIZARD_ANSWER,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'session-expired', WIZARD_NO_SESSION_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'invalid-name → illegal-move with the store validation message',
    event: { type: 'wizard.answer', playerId: USER, text: 'Bad@Name' },
    real: () => {
      const wizards = new WizardSession();
      wizards.start(USER);
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.answerResult = { kind: 'invalid-name', message: 'Name must not contain @ or # (Discord pings)' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', 'Name must not contain @ or # (Discord pings)'); expect(o.beats).toEqual([]); },
  },
  {
    name: 'illegal-step (name answer aimed at a non-step-1 session) → illegal-move with WIZARD_ILLEGAL_CHOICE_COPY',
    event: WIZARD_ANSWER,
    real: () => {
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 3); // session at step 3 — a step-1 name answer is illegal
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.answerResult = { kind: 'illegal-step' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', WIZARD_ILLEGAL_CHOICE_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'ok → ok:true wizard step-2 view (nameField gone, options + choice buttons), NO facts, zero beats',
    event: WIZARD_ANSWER,
    real: () => {
      const wizards = new WizardSession();
      wizards.start(USER);
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.answerResult = { kind: 'view', view: wizardStepNView(2) }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'wizard');
      assertWizardOptionStep(view);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — wizard.choose', [
  {
    name: 'no-session → session-expired with WIZARD_NO_SESSION_COPY',
    event: WIZARD_CHOOSE(2, 'Warrior'),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'session-expired', WIZARD_NO_SESSION_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'illegal-choice (right value, wrong step) → illegal-move with WIZARD_ILLEGAL_CHOICE_COPY (transcript 19 pins the paint)',
    event: WIZARD_CHOOSE(3, 'Soldier'),
    real: () => {
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 2); // session is at step 2 — a step-3 click is illegal
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.chooseResult = { kind: 'illegal-choice' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', WIZARD_ILLEGAL_CHOICE_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'ok → ok:true wizard step-3 view (options + choice buttons + restart), NO facts, zero beats',
    event: WIZARD_CHOOSE(2, 'Warrior'),
    real: () => {
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 2);
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.chooseResult = { kind: 'view', view: wizardStepNView(3) }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'wizard');
      assertWizardOptionStep(view);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — wizard.restart', [
  {
    name: 'mid-walk restart → ok:true wizard step-1 view, NO facts, zero beats (restart always starts fresh)',
    event: WIZARD_RESTART,
    real: () => {
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 5);
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter(),
    assert: (o) => {
      const view = expectOkView(o.response, 'wizard');
      assertWizardStep1(view);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

// The `created` arm returns the first-day /hi view, so this block reads `new Date()` for the
// weekday/weekend branch exactly like hi.open below — pin the clock or it fails every weekend.
describe('conformance — character.create (fake timers: Wednesday 2026-07-15)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-07-15T12:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  runCaseBlock('conformance — character.create', [
  {
    name: 'no-session → session-expired with WIZARD_NO_SESSION_COPY',
    event: CHARACTER_CREATE,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'session-expired', WIZARD_NO_SESSION_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'not-ready (session below step 8) → illegal-move with WIZARD_NOT_READY_COPY',
    event: CHARACTER_CREATE,
    real: () => {
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 2);
      return realRouter(new MockWorldEngine(), wizards);
    },
    stub: () => stubRouter((s) => { s.confirmResult = { kind: 'not-ready' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', WIZARD_NOT_READY_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'created → ok:true hi-greeting notice view + the createdCharacter fact + character facts (per the backend getCharacter), zero beats',
    event: CHARACTER_CREATE,
    real: () => {
      // MockWorldEngine.createCharacter does not persist into getCharacter (M7.0 review
      // note 3 — the bookend oracle depends on the canned char): the canned char stands
      // in for the created row so composeHiScreen + the character facts have a snapshot.
      const wizards = new WizardSession();
      seedWizard(wizards, USER, 8);
      return realRouter(realChar({ dayJob: 'Town Guard' }), wizards);
    },
    stub: () => stubRouter((s) => { s.confirmResult = WIZARD_CREATED; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.ephemeral).toBe(true);
      expect(view.text).toContain("The Warden's Oak");
      expect(view.text).toContain('Daily Work');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.createdCharacter).toEqual(CREATED_DATA);
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
      expect(o.response.facts?.nav).toMatchObject({ rollsRemaining: expect.any(Number), hasPendingAction: false, hasRestedToday: false });
      expect(o.beats).toEqual([]);
    },
  },
  ]);
});

// ── M8.1 screens (DC-M8.4) — the six screen.* events. The five char-gated events: the
// no-character arm uses NO_CHARACTER_COPY (the recorded "yet"→"first" unification pinned
// by the screens oracle's five charless-nav transcripts), the view arm returns the notice
// screen + character facts. screen.help has NO no-character arm (DC-M8.3 — help works
// charless today), so its charless real-backend case still resolves to the view with no
// facts. No beats on any of them. ──

runCaseBlock('conformance — screen.look', [
  {
    name: 'no-character → no-character with NO_CHARACTER_COPY (the charless nav edges, pinned by transcript 4)',
    event: SCREEN_LOOK,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'view → ok:true notice scene with character facts, zero beats',
    event: SCREEN_LOOK,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.lookResult = { kind: 'view', view: SCREEN_VIEWS.look }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('The Warden');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toBeDefined();
      expect(o.response.facts?.nav).toMatchObject({ rollsRemaining: expect.any(Number), hasPendingAction: false, hasRestedToday: false });
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — screen.map', [
  {
    name: 'no-character → no-character with NO_CHARACTER_COPY',
    event: SCREEN_MAP(),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'full map (no focus) → ok:true notice view with character facts',
    event: SCREEN_MAP(),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.mapResult = { kind: 'view', view: SCREEN_VIEWS.map }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text.length).toBeGreaterThan(0);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toBeDefined();
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'focus drill-down → ok:true notice view (the slash arm forwards the adapter-extracted place)',
    event: SCREEN_MAP('The Vale'),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.mapResult = { kind: 'view', view: SCREEN_VIEWS.map }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text.length).toBeGreaterThan(0);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — screen.stats', [
  {
    name: 'no-character → no-character with NO_CHARACTER_COPY',
    event: SCREEN_STATS,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'view → ok:true notice sheet with character facts, zero beats',
    event: SCREEN_STATS,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.statsResult = { kind: 'view', view: SCREEN_VIEWS.stats }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Warrior');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toBeDefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — screen.backpack', [
  {
    name: 'no-character → no-character with NO_CHARACTER_COPY',
    event: SCREEN_BACKPACK,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'view → ok:true notice grid with character facts, zero beats',
    event: SCREEN_BACKPACK,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.backpackResult = { kind: 'view', view: SCREEN_VIEWS.backpack }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Backpack');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toBeDefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — screen.journal', [
  {
    name: 'no-character → no-character with NO_CHARACTER_COPY',
    event: SCREEN_JOURNAL,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'view → ok:true notice chronicle with character facts, zero beats',
    event: SCREEN_JOURNAL,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.journalResult = { kind: 'view', view: SCREEN_VIEWS.journal }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Journal');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.response.facts?.characterState).toBeDefined();
      expect(o.beats).toEqual([]);
    },
  },
]);

runCaseBlock('conformance — screen.help', [
  {
    name: 'charless → ok:true notice view with NO facts (no no-character arm — the DC-M8.3 no-gate pin)',
    event: SCREEN_HELP,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter((s) => { s.helpResult = { kind: 'view', view: SCREEN_VIEWS.help }; s.character = null; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Command List');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'with-char → ok:true notice view with character facts (the identical text either way)',
    event: SCREEN_HELP,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.helpResult = { kind: 'view', view: SCREEN_VIEWS.help }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Command List');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.characterName).toBe('Aldric');
      expect(o.beats).toEqual([]);
    },
  },
]);

// ── menu.open (DC-P6: stampLastPlayed FIRST, then the menu branch) ──

runCaseBlock('conformance — menu.open', [
  {
    name: 'no-character → no-character with the menu copy',
    event: MENU_OPEN,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_MENU_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'no-rolls → the 🛌 copy',
    event: MENU_OPEN,
    real: () => realRouter(realChar({ rollsRemaining: 0 })),
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'no-rolls' }; }),
    assert: (o) => { expectError(o.response, 'no-rolls', NO_ROLLS_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'fresh menu view',
    event: MENU_OPEN,
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'menu', view: menuView }; }),
    assert: (o) => {
      expectOkView(o.response, 'menu');
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'resume-stale → stale-session carrying facts.narration',
    event: MENU_OPEN,
    real: () => {
      const engine = realChar({ lastActionState: IN_FLIGHT as never });
      engine.setResumeResult({
        state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
        nextDecision: { prompt: 'The trail has gone cold.', options: [], narration: 'You lost the trail.' },
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'resume-stale', prompt: 'The trail has gone cold.', narration: 'You lost the trail.' }; }),
    assert: (o) => {
      expectError(o.response, 'stale-session', 'The trail has gone cold.');
      if (o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.narration).toBe('You lost the trail.');
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'resume-stale without narration → stale-session, no facts',
    event: MENU_OPEN,
    real: () => {
      const engine = realChar({ lastActionState: IN_FLIGHT as never });
      engine.setResumeResult({
        state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
        nextDecision: { prompt: 'The trail has gone cold.', options: [] },
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'resume-stale', prompt: 'The trail has gone cold.' }; }),
    assert: (o) => {
      expectError(o.response, 'stale-session', 'The trail has gone cold.');
      if (o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toBeUndefined();
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'resume-decision → ok:true decision view',
    event: MENU_OPEN,
    real: () => {
      const engine = realChar({ lastActionState: IN_FLIGHT as never });
      engine.setResumeResult({
        state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
        nextDecision: {
          prompt: 'The trail forks. Which way?',
          options: [
            { label: 'Left', dcModifier: 0 },
            { label: 'Right', dcModifier: 1 },
          ],
        },
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'resume-decision', view: decisionView }; }),
    assert: (o) => { expectOkView(o.response, 'decision'); expect(o.beats).toEqual([]); },
  },
  {
    name: 'resume-error → internal with the resume message',
    event: MENU_OPEN,
    real: () => realRouter(realChar({ lastActionState: IN_FLIGHT as never })), // no resume result → resumeAction throws
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'resume-error', message: 'resume exploded' }; }),
    assert: (o) => { expectInternal(o.response); expect(o.beats).toEqual([]); },
  },
  {
    // M9.2 (DC-M9.2.3): composeActionMenu is now called TRIED inside openActionMenu — a
    // throw (an unknown day job, on the real backend) no longer escapes as ok:false
    // 'internal'; it returns the byte-identical day-job-name fallback copy
    // (commands/action.ts:133's old inline text) as an ok:true notice.
    name: 'composeActionMenu throws → ok:true, the day-job-name fallback notice (DC-M9.2.3)',
    event: MENU_OPEN,
    real: () => realRouter(realChar({ dayJob: 'Astronaut' })),
    stub: () => stubRouter((s) => { s.menuResult = { kind: 'menu-fallback', text: '🔧 **Astronaut**\n\nUse `/action <what you do>` to start an action.' }; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice') as NoticeViewState;
      expect(view.text).toContain('Use `/action <what you do>` to start an action.');
      expect(view.ephemeral).toBe(true);
      expect(o.beats).toEqual([]);
    },
  },
  {
    // The genuinely-still-throwing arm: a backend failure OTHER than composeActionMenu's
    // own try/catch (an engine read openActionMenu doesn't guard) still reaches the
    // router's own outer catch → ok:false 'internal', exactly as before M9.2.
    name: 'backend throw → internal (real: engine.getCharacter throws; stub: scripted throw)',
    event: MENU_OPEN,
    real: () => {
      const engine = realChar();
      vi.spyOn(engine, 'getCharacter').mockImplementation(() => { throw new Error('getCharacter boom'); });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.menuResult = 'throw'; }),
    assert: (o) => { expectInternal(o.response); expect(o.beats).toEqual([]); },
  },
]);

// ── dayjob.start (DC-P6: beginDayJob → loading beat → commuteForWork → commute beat when
// commuted → runWork) ──

runCaseBlock('conformance — dayjob.start', [
  {
    name: 'no-character → no-character with the other-events copy',
    event: DAYJOB_START(0),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'out-of-range jobIndex → illegal-move',
    event: DAYJOB_START(5),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.dayJobResult = { kind: 'invalid-job' }; }),
    assert: (o) => { expectError(o.response, 'illegal-move', INVALID_JOB_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'unsafe ground → unsafe with the ⚠️ copy and location interpolated',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar({ location: 'The Dark Woods' });
      engine.setLocation({ name: 'The Dark Woods', description: 'Spiders.', tags: [], isSafe: false, emoji: '🌲' });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.dayJobResult = { kind: 'unsafe', location: 'The Dark Woods' }; }),
    assert: (o) => { expectError(o.response, 'unsafe', UNSAFE_COPY('The Dark Woods')); expect(o.beats).toEqual([]); },
  },
  {
    name: 'ok + commute + work outcome → loading beat, commute beat, ok:true outcome with facts',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
      engine.setStartActionResult(RESOLVED_WORK);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'Walk the rounds — The wall is quiet tonight.', wage: 5 };
      s.commuteResult = { kind: 'commuted', destination: 'The Town Gate' };
      // Observably equivalent to the real backend's commute-then-work re-read (DC-P7): the
      // commute above costs 1 stamina, so both prevChar and char reflect it — STUB_OUTCOME's
      // plain stubChar wouldn't (it never models the commute mutation).
      s.workResult = { ...STUB_OUTCOME, prevChar: { ...stubChar, stamina: 9 }, char: { ...stubChar, stamina: 9 } } as Extract<StartRenderResult, { kind: 'outcome' }>;
    }),
    assert: (o) => {
      expectOkView(o.response, 'outcome');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toMatchObject({
        distilledType: 'scout',
        characterName: 'Aldric',
        actionId: 77,
        nav: { rollsRemaining: 3, hasPendingAction: false, hasRestedToday: false },
      });
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
      expect(Object.keys(o.response.facts?.characterState ?? {}).sort()).toEqual(
        ['health', 'location', 'maxHealth', 'maxStamina', 'stamina', 'wealth'],
      );
      // collapse (DC-M9.2) — rides every outcome envelope with a post-action char. `prevChar`
      // is read in `runWork` AFTER `commuteForWork` already applied the commute's stamina
      // cost (9, per the canned commute result above) — the mock never mutates vitals beyond
      // that, so prev === updated on this path.
      expect(o.response.facts?.collapse).toEqual({
        name: 'Aldric',
        prev: { health: 10, stamina: 9 },
        updated: { health: 10, stamina: 9 },
      });
      expect(o.beats).toHaveLength(2);
      expect(okView(o.beats[0])).toMatchObject({ screen: 'loading', body: `⏳ **Starting…**\n_${IDLE}_` });
      expect(okView(o.beats[1])).toEqual({ screen: 'commute', destination: 'The Town Gate', idle: IDLE });
    },
  },
  {
    name: 'ok + no commute → loading beat only, then a decision view',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult(null);
      engine.setStartActionResult(DECISION_WORK);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'Walk the rounds — The wall is quiet tonight.', wage: 5 };
      s.commuteResult = { kind: 'none' };
      s.workResult = { kind: 'decision', view: decisionView };
    }),
    assert: (o) => {
      expectOkView(o.response, 'decision');
      expect(o.beats).toHaveLength(1);
      expect(okView(o.beats[0])).toMatchObject({ screen: 'loading' });
    },
  },
  {
    // M9.1 (DC-M9.3): the divine arm crosses as an error envelope on a tenth code, ahead of
    // the outcome branch — the loading beat still fires (it precedes runWork), but there is
    // no commute beat and no outcome view; assert what actually happens, not `[]`.
    name: 'divine intervention → divine-intervention error after the loading beat only',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult(null);
      engine.setStartActionResult(DIVINE_WORK);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
      s.commuteResult = { kind: 'none' };
      s.workResult = { kind: 'divine', text: DIVINE_TEXT };
    }),
    assert: (o) => {
      expectError(o.response, 'divine-intervention', DIVINE_TEXT);
      expect(o.beats).toHaveLength(1);
      expect(okView(o.beats[0])).toMatchObject({ screen: 'loading' });
    },
  },
  {
    name: 'empty-action with empty prompt → the Could-not-recover fallback (Execution-state settle 1)',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult(null);
      engine.setStartActionResult({
        state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'work' },
        firstDecision: { prompt: '', options: [] },
        actionType: 'other',
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
      s.workResult = { kind: 'empty-action', prompt: '' };
    }),
    assert: (o) => expectError(o.response, 'empty-action', 'Could not recover.'),
  },
  {
    name: 'empty-action with a prompt → the prompt verbatim',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult(null);
      engine.setStartActionResult({
        state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'work' },
        firstDecision: { prompt: 'The path ends.', options: [] },
        actionType: 'other',
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
      s.workResult = { kind: 'empty-action', prompt: 'The path ends.' };
    }),
    assert: (o) => expectError(o.response, 'empty-action', 'The path ends.'),
  },
  {
    name: 'runWork throws → internal, never a rejection',
    event: DAYJOB_START(0),
    real: () => {
      const engine = realChar();
      engine.setCommuteResult(null);
      // no canned startActionResult → startAction throws inside runWork
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
      s.workResult = 'throw';
    }),
    assert: (o) => expectInternal(o.response),
  },
]);

// ── action.custom (DC-P6: beginCustomAction → resume short-circuits; else thinking beat →
// runCustomAction) ──

runCaseBlock('conformance — action.custom', [
  {
    name: 'no-character → no-character',
    event: ACTION_CUSTOM,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'in-flight action resumes → ok:true decision view, no thinking beat',
    event: ACTION_CUSTOM,
    real: () => {
      const engine = realChar({ lastActionState: IN_FLIGHT as never });
      engine.setResumeResult({
        state: { rawInput: 'scout the ridge', decisions: [], accumulatedDc: 10, kind: 'quest' },
        nextDecision: {
          prompt: 'The trail forks. Which way?',
          options: [
            { label: 'Left', dcModifier: 0 },
            { label: 'Right', dcModifier: 1 },
          ],
        },
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => { s.customResult = { kind: 'resume', view: decisionView }; }),
    assert: (o) => { expectOkView(o.response, 'decision'); expect(o.beats).toEqual([]); },
  },
  {
    // DC-M9.2 fix: the pre-port top guard (rollsRemaining <= 0 && !lastActionState) never
    // crossed the seam — moved behind beginCustomAction. Precedes the loading beat, exactly
    // like menu.open's own no-rolls arm above.
    name: 'no-rolls, no pending action → the 🛌 copy, no beat',
    event: ACTION_CUSTOM,
    real: () => realRouter(realChar({ rollsRemaining: 0, lastActionState: null })),
    stub: () => stubRouter((s) => { s.customResult = { kind: 'no-rolls' }; }),
    assert: (o) => { expectError(o.response, 'no-rolls', NO_ROLLS_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'start → thinking beat, then a decision view',
    event: ACTION_CUSTOM,
    real: () => {
      const engine = realChar();
      engine.setStartActionResult(DECISION_QUEST);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.customResult = { kind: 'start' };
      s.customWorkResult = { kind: 'decision', view: decisionView };
    }),
    assert: (o) => {
      expectOkView(o.response, 'decision');
      expect(o.beats).toHaveLength(1);
      expect(okView(o.beats[0])).toEqual({ screen: 'loading', body: `**You:** scout the ridge\n\n⏳ **Thinking…**\n_${IDLE}_` });
    },
  },
  {
    name: 'start → auto-finish outcome with facts (no characterClass on this path)',
    event: ACTION_CUSTOM,
    real: () => {
      const engine = realChar();
      engine.setStartActionResult(RESOLVED_START);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.customResult = { kind: 'start' };
      s.customWorkResult = STUB_OUTCOME;
    }),
    assert: (o) => {
      expectOkView(o.response, 'outcome');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toMatchObject({
        distilledType: 'scout',
        characterName: 'Aldric',
        actionId: 77,
        nav: { rollsRemaining: 3, hasPendingAction: false, hasRestedToday: false },
      });
      // characterClass is now populated by addCharacterFacts (DC-M6.1) on all view-bearing
      // responses — the stub char has class 'Warrior'.
      expect(o.response.facts?.characterClass).toBe('Warrior');
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
      expect(Object.keys(o.response.facts?.characterState ?? {}).sort()).toEqual(
        ['health', 'location', 'maxHealth', 'maxStamina', 'stamina', 'wealth'],
      );
      // collapse (DC-M9.2) — see the dayjob.start case's note on prev === updated.
      expect(o.response.facts?.collapse).toEqual({
        name: 'Aldric',
        prev: { health: 10, stamina: 10 },
        updated: { health: 10, stamina: 10 },
      });
    },
  },
  {
    // M9.1 (DC-M9.3): same tenth-code crossing as dayjob.start above — the thinking beat
    // still fires (it precedes runCustomAction), but there is no outcome view.
    name: 'divine intervention → divine-intervention error after the thinking beat only',
    event: ACTION_CUSTOM,
    real: () => {
      const engine = realChar();
      engine.setStartActionResult(DIVINE_START);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.customResult = { kind: 'start' };
      s.customWorkResult = { kind: 'divine', text: DIVINE_TEXT };
    }),
    assert: (o) => {
      expectError(o.response, 'divine-intervention', DIVINE_TEXT);
      expect(o.beats).toHaveLength(1);
      expect(okView(o.beats[0])).toEqual({ screen: 'loading', body: `**You:** scout the ridge\n\n⏳ **Thinking…**\n_${IDLE}_` });
    },
  },
  {
    name: 'empty-action with empty prompt → the Could-not-recover fallback',
    event: ACTION_CUSTOM,
    real: () => {
      const engine = realChar();
      engine.setStartActionResult({
        state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'quest' },
        firstDecision: { prompt: '', options: [] },
        actionType: 'other',
      });
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.customResult = { kind: 'start' };
      s.customWorkResult = { kind: 'empty-action', prompt: '' };
    }),
    assert: (o) => expectError(o.response, 'empty-action', 'Could not recover.'),
  },
  {
    name: 'runCustomAction throws → internal',
    event: ACTION_CUSTOM,
    real: () => realRouter(realChar()), // no canned startActionResult → startAction throws
    stub: () => stubRouter((s) => {
      s.customResult = { kind: 'start' };
      s.customWorkResult = 'throw';
    }),
    assert: (o) => expectInternal(o.response),
  },
]);

// DC-M9.3.1/DC-M9.3.8/DC-M9.3.9 — the profanity guard moved into the router's action.custom
// branch, ahead of beginCustomAction. Wrapped in beforeEach/afterEach + resetCache (the
// M9.3.0 net's own hermetic-env discipline) so process.env leaking here can't bleed into
// other suites in the same run.
describe('action.custom profanity guard (DC-M9.3.1 move)', () => {
  const priorFilter = process.env.PROFANITY_FILTER;
  const PROFANE_ACTION = { type: 'action.custom' as const, playerId: USER, text: 'go frack around the ridge' };

  beforeEach(() => {
    process.env.PROFANITY_FILTER = '\\bfrack\\b';
    resetCache();
  });

  afterEach(() => {
    if (priorFilter === undefined) delete process.env.PROFANITY_FILTER;
    else process.env.PROFANITY_FILTER = priorFilter;
    resetCache();
  });

  it('profane text rejects with illegal-move and the adapter\'s exact copy, no beat, the backend never touched (real backend)', async () => {
    const engine = realChar();
    const o = await drive(realRouter(engine), PROFANE_ACTION);
    expectError(o.response, 'illegal-move', PROFANITY_COPY);
    expect(o.beats).toEqual([]);
    expect(engine.calls.startAction).toHaveLength(0);
  });

  it('profane text rejects with illegal-move and the adapter\'s exact copy, no beat (stub backend)', async () => {
    const o = await drive(stubRouter(), PROFANE_ACTION);
    expectError(o.response, 'illegal-move', PROFANITY_COPY);
    expect(o.beats).toEqual([]);
  });

  it('DC-M9.3.9 ordering proof — profane text from a player with no character rejects on profanity, not on the missing character', async () => {
    const o = await drive(realRouter(new MockWorldEngine()), PROFANE_ACTION);
    expectError(o.response, 'illegal-move', PROFANITY_COPY);
    expect(o.beats).toEqual([]);
  });
});

// DC-M9.2.2 — the threading proof, real backend only (no stub arm: StubBackend never builds
// a DecisionViewState through buildDecisionView, so it cannot exercise this loss). `actionType`,
// `combatEnemyName` and `combatEnemyCondition` are consumed INSIDE buildDecisionView to select
// and fill the opening frame, and only the rendered `openingFrame` string survives onto
// DecisionViewState — so this is the only layer that can prove the fix, and every oracle
// fixture arc-wide omits `actionType` deliberately (keeps the ANSI renderer out of dispatch-level
// determinism scope), which is why the byte gate is structurally blind here. Before the
// SessionController.ts:590 fix (args 6/7 missing from the buildDecisionView call), this fails:
// the frame renders the "Unknown foe" / "?/?" placeholders instead of the real enemy.
it('DC-M9.2.2 threading proof — action.custom\'s decision view carries the combat opening frame\'s enemy name + banded condition', async () => {
  const engine = realChar();
  engine.setStartActionResult(DECISION_COMBAT);
  const router = realRouter(engine);
  const response = await router.dispatch(ACTION_CUSTOM);
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error('unreachable');
  const view = response.view as DecisionViewState;
  expect(view.openingFrame).toBeDefined();
  expect(view.openingFrame).toContain('Ironback Boar');
  expect(view.openingFrame).toContain('Bloodied');
  expect(view.openingFrame).not.toContain('Unknown foe');
  expect(view.openingFrame).not.toContain('?/?');
});

// ── action.choose (DC-P6: beginChoice → resolveChoice → thinking beat → stepChoice) ──

runCaseBlock('conformance — action.choose', [
  {
    name: 'no-character → no-character',
    event: ACTION_CHOOSE,
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter(),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'resolveChoice returns null → session-expired',
    event: ACTION_CHOOSE,
    real: () => {
      const engine = realChar();
      engine.setPendingChoiceOptions([]); // no last_action_state → the option resolves to null
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.choiceResult = { kind: 'ok', character: stubChar };
      s.resolveResult = null;
    }),
    assert: (o) => { expectError(o.response, 'session-expired', SESSION_EXPIRED_COPY); expect(o.beats).toEqual([]); },
  },
  {
    name: 'option resolves → thinking beat with the label, then a decision view',
    event: ACTION_CHOOSE,
    real: () => {
      const engine = realChar();
      engine.setPendingChoiceOptions(PENDING_OPTIONS);
      engine.setStepActionResult(NEXT_DECISION_STEP);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.choiceResult = { kind: 'ok', character: stubChar };
      s.resolveResult = 'Advance carefully';
      s.stepResult = { kind: 'decision', view: decisionView };
    }),
    assert: (o) => {
      expectOkView(o.response, 'decision');
      expect(o.beats).toHaveLength(1);
      expect(okView(o.beats[0])).toEqual({ screen: 'loading', body: `**You:** Advance carefully\n\n⏳ **Thinking…**\n_${IDLE}_` });
    },
  },
  {
    name: 'resolved outcome → ok:true outcome with characterClass and nav facts',
    event: ACTION_CHOOSE,
    real: () => {
      const engine = realChar();
      engine.setPendingChoiceOptions(PENDING_OPTIONS);
      engine.setStepActionResult(RESOLVED_STEP);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.choiceResult = { kind: 'ok', character: stubChar };
      s.resolveResult = 'Advance carefully';
      s.stepResult = STUB_STEP_OUTCOME;
    }),
    assert: (o) => {
      expectOkView(o.response, 'outcome');
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts).toMatchObject({
        distilledType: 'scout',
        characterName: 'Aldric',
        characterClass: 'Warrior',
        actionId: 77,
        nav: { rollsRemaining: 3, hasPendingAction: false, hasRestedToday: false },
      });
      expect(o.response.facts?.characterState).toMatchObject({
        health: expect.any(Number),
        maxHealth: expect.any(Number),
        stamina: expect.any(Number),
        maxStamina: expect.any(Number),
        wealth: expect.any(Number),
        location: expect.any(String),
      });
      expect(Object.keys(o.response.facts?.characterState ?? {}).sort()).toEqual(
        ['health', 'location', 'maxHealth', 'maxStamina', 'stamina', 'wealth'],
      );
      // collapse (DC-M9.2) — see the dayjob.start case's note on prev === updated.
      expect(o.response.facts?.collapse).toEqual({
        name: 'Aldric',
        prev: { health: 10, stamina: 10 },
        updated: { health: 10, stamina: 10 },
      });
    },
  },
  {
    name: 'bail selector → thinking beat with the bail label',
    event: ACTION_BAIL,
    real: () => {
      const engine = realChar();
      engine.setPendingChoiceOptions(PENDING_OPTIONS);
      engine.setStepActionResult(NEXT_DECISION_STEP);
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.choiceResult = { kind: 'ok', character: stubChar };
      s.resolveResult = 'Fall back';
      s.stepResult = { kind: 'decision', view: decisionView };
    }),
    assert: (o) => {
      expectOkView(o.response, 'decision');
      expect(okView(o.beats[0])).toMatchObject({ body: `**You:** Fall back\n\n⏳ **Thinking…**\n_${IDLE}_` });
    },
  },
  {
    name: 'stepChoice throws → internal',
    event: ACTION_CHOOSE,
    real: () => {
      const engine = realChar();
      engine.setPendingChoiceOptions(PENDING_OPTIONS);
      // no canned stepActionResult → stepAction throws inside stepChoice
      return realRouter(engine);
    },
    stub: () => stubRouter((s) => {
      s.choiceResult = { kind: 'ok', character: stubChar };
      s.resolveResult = 'Advance carefully';
      s.stepResult = 'throw';
    }),
    assert: (o) => expectInternal(o.response),
  },
]);

// ── collapse (DC-M9.2) — absent when the post-action char is null. Stub-only: the real
// MockWorldEngine cannot produce a resolved outcome with no post-action character (the
// M9.0 execution-state note records reaching this as characterising a concurrent-deletion
// state the mock cannot script, not a coverage gap). ──

describe('collapse fact (DC-M9.2) — negative space', () => {
  it('action.choose outcome with a null post-action char → no collapse fact (and no nav — addCharacterFacts sees the same gone character)', async () => {
    const stub = new StubBackend();
    stub.choiceResult = { kind: 'ok', character: stubChar };
    stub.resolveResult = 'Advance carefully';
    stub.stepResult = { ...STUB_STEP_OUTCOME, char: null } as Extract<StepChoiceResult, { kind: 'outcome' }>;
    stub.character = null;
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), ACTION_CHOOSE);
    expectOkView(o.response, 'outcome');
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts?.collapse).toBeUndefined();
    expect(o.response.facts?.nav).toBeUndefined();
  });
});

// ── The nav fact (DC-M9.6) — the three arms M9.3.2c added it to. The adapter's nav-button
// weld is its only consumer, and it reads exactly three fields, so these pin the fact's
// shape as well as its presence: a `nav` short a field paints a wrong bar, not a crash. ──

describe('nav facts (DC-M9.6) — the arms that owe the adapter a nav bar', () => {
  const NAV_SHAPE = { rollsRemaining: expect.any(Number), hasPendingAction: expect.any(Boolean), hasRestedToday: expect.any(Boolean) };

  it('rest.begin guard rejections carry a NARROW nav fact — the bar survives the ⛔ screens', async () => {
    for (const kind of ['mid-action', 'rolls-remaining'] as const) {
      const stub = new StubBackend();
      stub.restResult = { kind };
      stub.character = { ...stubChar, rollsRemaining: 2, hasRestedToday: false };
      const o = await drive(new GameRouter(stub, { idle: () => IDLE }), REST_BEGIN);
      if (o.response.ok) throw new Error('unreachable');
      // Literal, not a mirror of the router's own expression: stubChar has no pending
      // action, so the polarity is pinned rather than recomputed.
      expect(o.response.facts?.nav).toEqual({ rollsRemaining: 2, hasPendingAction: false, hasRestedToday: false });
      // Narrow on purpose (the judge's M9.3.2c refinement): the weld is the only consumer,
      // so these arms do NOT ship the rested arm's characterState/characterName.
      expect(o.response.facts?.characterState).toBeUndefined();
      expect(o.response.facts?.characterName).toBeUndefined();
    }
  });

  it('rest.begin no-character carries no facts at all — which IS the adapter’s no-bar fallback', async () => {
    const stub = new StubBackend();
    stub.restResult = { kind: 'no-character' };
    stub.character = null;
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), REST_BEGIN);
    if (o.response.ok) throw new Error('unreachable');
    expect(o.response.facts).toBeUndefined();
  });

  it('the two SLASH feedback surfaces carry nav; the four in-message surfaces carry none', async () => {
    for (const event of [FEEDBACK('slash-feedback'), BUG_SURFACE('slash-bug')]) {
      const stub = new StubBackend();
      stub.confirmationResult = noticeView;
      const o = await drive(new GameRouter(stub, { idle: () => IDLE }), event);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.nav).toMatchObject(NAV_SHAPE);
    }
    for (const event of [FEEDBACK('sleep'), FEEDBACK('release'), FEEDBACK('outcome-feedback', 42), BUG(7)]) {
      const stub = new StubBackend();
      stub.confirmationResult = noticeView;
      const o = await drive(new GameRouter(stub, { idle: () => IDLE }), event);
      if (!o.response.ok) throw new Error('unreachable');
      expect(o.response.facts?.nav).toBeUndefined();
    }
  });

  it('a slash surface whose persist throws carries BOTH nav and persistFailed', async () => {
    const stub = new StubBackend();
    stub.confirmationResult = noticeView;
    stub.recordResult = 'throw';
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), FEEDBACK('slash-feedback'));
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts?.persistFailed).toBe(true);
    expect(o.response.facts?.nav).toMatchObject(NAV_SHAPE);
  });

  it('an INTERNAL fault still carries nav — the fault screen keeps its bar, as it did before the port', async () => {
    const stub = new StubBackend();
    stub.statsResult = 'throw';
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), SCREEN_STATS);
    expectInternal(o.response);
    expect(o.response.facts?.nav).toMatchObject(NAV_SHAPE);
  });

  it('an internal fault with no character carries the fault marker but no nav — and a THROWING character read is swallowed, not re-raised', async () => {
    const charless = new StubBackend();
    charless.statsResult = 'throw';
    charless.character = null;
    const o = await drive(new GameRouter(charless, { idle: () => IDLE }), SCREEN_STATS);
    expectInternal(o.response);
    expect(o.response.facts?.nav).toBeUndefined();
    expect(o.response.facts?.internalFault).toBe(true);

    const broken = new StubBackend();
    broken.statsResult = 'throw';
    broken.getCharacter = () => { throw new Error('the character read itself is broken'); };
    const o2 = await drive(new GameRouter(broken, { idle: () => IDLE }), SCREEN_STATS);
    expectInternal(o2.response); // never a rejection, even when the fallback read faults too
    expect(o2.response.facts?.nav).toBeUndefined();
  });

  // The blocker the first fresh-context reviewer found: 'internal' has TWO sources and the
  // pre-port adapter paged the admin for exactly one of them. `internalFault` is what tells
  // them apart, so a player walking away from a decision screen for 30 minutes no longer
  // wakes an operator (M9.2's blocker 1, one leaf over).
  it('a THROWN internal carries internalFault; a MAPPED internal (menu.open resume-error) does not', async () => {
    const thrown = new StubBackend();
    thrown.menuResult = 'throw';
    const o = await drive(new GameRouter(thrown, { idle: () => IDLE }), MENU_OPEN);
    expectInternal(o.response);
    expect(o.response.facts?.internalFault).toBe(true);

    const mapped = new StubBackend();
    mapped.menuResult = { kind: 'resume-error', message: '⏳ That action timed out. Start a new one.' };
    const o2 = await drive(new GameRouter(mapped, { idle: () => IDLE }), MENU_OPEN);
    expectInternal(o2.response);
    if (o2.response.ok) throw new Error('unreachable');
    expect(o2.response.error.message).toBe('⏳ That action timed out. Start a new one.');
    expect(o2.response.facts?.internalFault).toBeUndefined();
  });
});

// ── feedback.submit / bug.submit (reply-first best-effort) ──

runCaseBlock('conformance — feedback.submit', [
  {
    name: 'sleep surface → the sleep confirmation notice',
    event: FEEDBACK('sleep'),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.confirmationResult = noticeView; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toBe('🙏 Thanks. The warden listens.');
    },
  },
  {
    name: 'release surface → the release confirmation notice',
    event: FEEDBACK('release'),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => {
      s.confirmationResult = { screen: 'notice', text: '🙏 Noted. The warden carries your words forward.', ephemeral: true };
    }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toBe('🙏 Noted. The warden carries your words forward.');
    },
  },
  {
    name: 'outcome-feedback surface with actionId → confirmation notice',
    event: FEEDBACK('outcome-feedback', 42),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.confirmationResult = noticeView; }),
    assert: (o) => {
      expectOkView(o.response, 'notice');
      expect(o.beats).toEqual([]);
    },
  },
  {
    name: 'no character → still the confirmation notice (persist no-ops)',
    event: FEEDBACK('sleep'),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter((s) => { s.confirmationResult = noticeView; }),
    assert: (o) => expectOkView(o.response, 'notice'),
  },
  {
    // DC-M9.5: the /feedback slash surface — same confirmation copy as 'sleep', but see the
    // next case: unlike the other four surfaces, a charless slash surface does NOT reply-first.
    name: 'slash-feedback surface → the same confirmation notice as sleep',
    event: FEEDBACK('slash-feedback'),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => { s.confirmationResult = noticeView; }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toBe('🙏 Thanks. The warden listens.');
    },
  },
  {
    // DC-M9.5: the router guards the two slash surfaces on a character (matching
    // commands/feedback.ts today) — the recorded "yet"→"first" unification.
    name: 'slash-feedback with no character → no-character error, NOT the confirmation notice',
    event: FEEDBACK('slash-feedback'),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter((s) => { s.character = null; }),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
]);

runCaseBlock('conformance — bug.submit', [
  {
    name: 'bug surface → the outcome-bug confirmation notice',
    event: BUG(),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => {
      s.confirmationResult = { screen: 'notice', text: '🐛 Bug noted. The warden will investigate.', ephemeral: true };
    }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toBe('🐛 Bug noted. The warden will investigate.');
    },
  },
  {
    name: 'no character → still the confirmation notice',
    event: BUG(7),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter((s) => {
      s.confirmationResult = { screen: 'notice', text: '🐛 Bug noted. The warden will investigate.', ephemeral: true };
    }),
    assert: (o) => expectOkView(o.response, 'notice'),
  },
  {
    // DC-M9.5: the /bug slash surface — same confirmation copy as the outcome surface.
    name: 'slash-bug surface → the same confirmation notice as outcome-bug',
    event: BUG_SURFACE('slash-bug'),
    real: () => realRouter(realChar()),
    stub: () => stubRouter((s) => {
      s.confirmationResult = { screen: 'notice', text: '🐛 Bug noted. The warden will investigate.', ephemeral: true };
    }),
    assert: (o) => {
      const view = expectOkView(o.response, 'notice');
      expect((view as NoticeViewState).text).toBe('🐛 Bug noted. The warden will investigate.');
    },
  },
  {
    // DC-M9.5: unlike bare bug.submit (no surface, reply-first), the slash-bug surface
    // guards on a character — matching commands/bug.ts today.
    name: 'slash-bug with no character → no-character error, NOT the confirmation notice',
    event: BUG_SURFACE('slash-bug'),
    real: () => realRouter(new MockWorldEngine()),
    stub: () => stubRouter((s) => { s.character = null; }),
    assert: (o) => { expectError(o.response, 'no-character', NO_CHARACTER_COPY); expect(o.beats).toEqual([]); },
  },
]);

// ── DC-P6 flow ordering, pinned on the stub's call log ──

describe('flow order (DC-P6) — the stub call log pins each leaf order', () => {
  it('menu.open: stampLastPlayed → openActionMenu (nav:action order)', async () => {
    const stub = new StubBackend();
    stub.menuResult = { kind: 'menu', view: menuView };
    await drive(new GameRouter(stub, { idle: () => IDLE }), MENU_OPEN);
    expect(stub.calls).toEqual(['stampLastPlayed', 'openActionMenu']);
  });

  it('dayjob.start: beginDayJob → [loading beat] → commuteForWork → runWork', async () => {
    const stub = new StubBackend();
    stub.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
    stub.workResult = { kind: 'decision', view: decisionView };
    const router = new GameRouter(stub, { idle: () => IDLE });

    // ONE interleaved log: the onBeat callback pushes a beat marker into the same array the
    // stub's call log uses, pinning the loading beat's position RELATIVE to the backend calls.
    const beats: GameResponse[] = [];
    const promise = router.dispatch(DAYJOB_START(0), (beat) => {
      beats.push(beat);
      stub.calls.push('<loading beat>');
    });
    await expect(promise).resolves.toBeDefined();
    const response = assertValid(await promise);
    for (const beat of beats) assertValid(beat);
    assertViewConformance(response);
    for (const beat of beats) assertViewConformance(beat);

    expect(stub.calls).toEqual(['beginDayJob', '<loading beat>', 'commuteForWork', 'runWork']);
  });

  it('action.custom: beginCustomAction → runCustomAction', async () => {
    const stub = new StubBackend();
    stub.customResult = { kind: 'start' };
    stub.customWorkResult = { kind: 'decision', view: decisionView };
    await drive(new GameRouter(stub, { idle: () => IDLE }), ACTION_CUSTOM);
    expect(stub.calls).toEqual(['beginCustomAction', 'runCustomAction']);
  });

  it('action.choose: beginChoice → resolveChoice → stepChoice', async () => {
    const stub = new StubBackend();
    stub.choiceResult = { kind: 'ok', character: stubChar };
    stub.resolveResult = 'Advance carefully';
    stub.stepResult = { kind: 'decision', view: decisionView };
    await drive(new GameRouter(stub, { idle: () => IDLE }), ACTION_CHOOSE);
    expect(stub.calls).toEqual(['beginChoice', 'resolveChoice', 'stepChoice']);
  });

  it('feedback.submit: feedbackConfirmation → recordFeedback', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), FEEDBACK('sleep'));
    expect(stub.calls).toEqual(['feedbackConfirmation', 'recordFeedback']);
  });

  it('bug.submit routes the outcome-bug surface through the controller', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), BUG(7));
    expect(stub.confirmationSurfaces).toEqual(['outcome-bug']);
    expect(stub.feedbackLog).toEqual([{ surface: 'outcome-bug', userId: USER, text: 'the door is stuck', actionId: 7 }]);
  });

  it('feedback.submit slash-feedback: feedbackConfirmation → recordFeedback (the getCharacter guard is a stub no-log read)', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), FEEDBACK('slash-feedback'));
    expect(stub.calls).toEqual(['feedbackConfirmation', 'recordFeedback']);
  });

  it('bug.submit routes the slash-bug surface through the controller', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), BUG_SURFACE('slash-bug'));
    expect(stub.confirmationSurfaces).toEqual(['slash-bug']);
    expect(stub.feedbackLog).toEqual([{ surface: 'slash-bug', userId: USER, text: 'the door is stuck', actionId: undefined }]);
  });

  it('rest.begin: beginRest is the only backend call (the character snapshot read is a stub no-log read, pinned by the facts assertions)', async () => {
    const stub = new StubBackend();
    stub.restResult = RESTED_SAFE;
    await drive(new GameRouter(stub, { idle: () => IDLE }), REST_BEGIN);
    expect(stub.calls).toEqual(['beginRest']);
  });

  it('hi.open: openHi is the only backend call (the character snapshot read is a stub no-log read, pinned by the facts assertions)', async () => {
    const stub = new StubBackend();
    stub.hiResult = HI_GREETING;
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), HI_OPEN);
    expect(stub.calls).toEqual(['openHi']);
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts?.characterName).toBe('Aldric');
    expect(o.response.facts?.characterState).toBeDefined();
    expect(o.response.facts?.nav).toBeDefined();
  });

  it('join.open: startWizard is the only backend call (DC-M7.3.11)', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), JOIN_OPEN);
    expect(stub.calls).toEqual(['startWizard']);
  });

  it('wizard.answer: answerWizardName is the only backend call', async () => {
    const stub = new StubBackend();
    stub.answerResult = { kind: 'view', view: wizardStepNView(2) };
    await drive(new GameRouter(stub, { idle: () => IDLE }), WIZARD_ANSWER);
    expect(stub.calls).toEqual(['answerWizardName']);
  });

  it('wizard.choose: chooseWizardOption is the only backend call', async () => {
    const stub = new StubBackend();
    stub.chooseResult = { kind: 'view', view: wizardStepNView(3) };
    await drive(new GameRouter(stub, { idle: () => IDLE }), WIZARD_CHOOSE(2, 'Warrior'));
    expect(stub.calls).toEqual(['chooseWizardOption']);
  });

  it('wizard.restart: restartWizard is the only backend call', async () => {
    const stub = new StubBackend();
    await drive(new GameRouter(stub, { idle: () => IDLE }), WIZARD_RESTART);
    expect(stub.calls).toEqual(['restartWizard']);
  });

  it('character.create: confirmWizard is the only backend call', async () => {
    const stub = new StubBackend();
    stub.confirmResult = WIZARD_CREATED;
    await drive(new GameRouter(stub, { idle: () => IDLE }), CHARACTER_CREATE);
    expect(stub.calls).toEqual(['confirmWizard']);
  });

  it('screen.look: openLook is the only backend call (the character snapshot read is a stub no-log read, pinned by the facts assertions)', async () => {
    const stub = new StubBackend();
    stub.lookResult = { kind: 'view', view: SCREEN_VIEWS.look };
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), SCREEN_LOOK);
    expect(stub.calls).toEqual(['openLook']);
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts?.characterName).toBe('Aldric');
  });

  it('screen.map: openMap is the only backend call (focus forwarded to the backend)', async () => {
    const stub = new StubBackend();
    stub.mapResult = { kind: 'view', view: SCREEN_VIEWS.map };
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), SCREEN_MAP('The Vale'));
    expect(stub.calls).toEqual(['openMap']);
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts?.characterName).toBe('Aldric');
  });

  it('screen.stats/backpack/journal: openStats/openBackpack/openJournal are the only backend calls', async () => {
    for (const [event, result, name] of [
      [SCREEN_STATS, 'statsResult', 'openStats'],
      [SCREEN_BACKPACK, 'backpackResult', 'openBackpack'],
      [SCREEN_JOURNAL, 'journalResult', 'openJournal'],
    ] as const) {
      const stub = new StubBackend();
      stub[result] = { kind: 'view', view: SCREEN_VIEWS[name === 'openStats' ? 'stats' : name === 'openBackpack' ? 'backpack' : 'journal'] };
      await drive(new GameRouter(stub, { idle: () => IDLE }), event);
      expect(stub.calls).toEqual([name]);
    }
  });

  it('screen.help: openHelp is the only backend call', async () => {
    const stub = new StubBackend();
    stub.character = null; // the charless no-gate case — no character facts follow
    const o = await drive(new GameRouter(stub, { idle: () => IDLE }), SCREEN_HELP);
    expect(stub.calls).toEqual(['openHelp']);
    if (!o.response.ok) throw new Error('unreachable');
    expect(o.response.facts).toBeUndefined(); // charless stub → no character facts
  });

  it('rest.begin unsafe arm adds the restUnsafe fact ONLY on unsafe rested envelopes', async () => {
    const stub = new StubBackend();
    stub.restResult = RESTED_SAFE;
    const safe = await drive(new GameRouter(stub, { idle: () => IDLE }), REST_BEGIN);
    expect(safe.response.ok && safe.response.facts?.restUnsafe).toBeUndefined();

    const stub2 = new StubBackend();
    stub2.restResult = RESTED_UNSAFE;
    const unsafe = await drive(new GameRouter(stub2, { idle: () => IDLE }), REST_BEGIN);
    if (!unsafe.response.ok) throw new Error('unreachable');
    expect(unsafe.response.facts?.restUnsafe).toBeDefined();
  });

  it('dayjob.start emits the commute beat ONLY when the commute happened', async () => {
    const commuted = new StubBackend();
    commuted.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
    commuted.commuteResult = { kind: 'commuted', destination: 'The Town Gate' };
    commuted.workResult = { kind: 'decision', view: decisionView };
    const withCommute = await drive(new GameRouter(commuted, { idle: () => IDLE }), DAYJOB_START(0));
    expect(beatScreens(withCommute.beats)).toEqual(['loading', 'commute']);

    const notCommuted = new StubBackend();
    notCommuted.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
    notCommuted.workResult = { kind: 'decision', view: decisionView };
    const without = await drive(new GameRouter(notCommuted, { idle: () => IDLE }), DAYJOB_START(0));
    expect(beatScreens(without.beats)).toEqual(['loading']);
  });
});

// ── Negative space (b): malformed events → ok:false invalid-event, never a rejection ──

const GARBAGE_EVENTS: unknown[] = [
  null,
  42,
  'menu.open',
  {},
  { type: 'menu.open' },
  { type: 'menu.open', playerId: 42 },
  { type: 'menu.open', playerId: '' },
  { type: 'dayjob.start', playerId: USER, jobIndex: -1 },
  { type: 'dayjob.start', playerId: USER, jobIndex: 1.5 },
  { type: 'dayjob.start', playerId: USER, jobIndex: 'x' },
  { type: 'action.custom', playerId: USER, text: '' },
  { type: 'action.custom', playerId: USER },
  { type: 'action.choose', playerId: USER, selector: { kind: 'option', index: -1 } },
  { type: 'action.choose', playerId: USER, selector: { kind: 'option', index: 1.5 } },
  { type: 'action.choose', playerId: USER, selector: { kind: 'nope' } },
  { type: 'action.choose', playerId: USER },
  { type: 'feedback.submit', playerId: USER, surface: 'nope', text: 'x' },
  { type: 'feedback.submit', playerId: USER, text: 'x' },
  { type: 'feedback.submit', playerId: USER, surface: 'sleep', text: 'x', actionId: 0 },
  { type: 'bug.submit', playerId: USER, text: 'x', actionId: -3 },
  { type: 'rest.begin' },
  { type: 'rest.begin', playerId: '' },
  { type: 'rest.begin', playerId: 42 },
  { type: 'hi.open' },
  { type: 'hi.open', playerId: '' },
  { type: 'hi.open', playerId: 42 },
  { type: 'join.open' },
  { type: 'join.open', playerId: '' },
  { type: 'wizard.answer', playerId: USER },
  { type: 'wizard.answer', playerId: USER, text: '' },
  { type: 'wizard.answer', playerId: USER, text: 42 },
  { type: 'wizard.choose', playerId: USER, value: 'Warrior' }, // missing step
  { type: 'wizard.choose', playerId: USER, step: 1.5, value: 'x' },
  { type: 'wizard.choose', playerId: USER, step: -1, value: 'x' },
  { type: 'wizard.choose', playerId: USER, step: 2 }, // missing value
  { type: 'wizard.choose', playerId: USER, step: 2, value: '' },
  { type: 'wizard.restart' },
  { type: 'character.create' },
  { type: 'character.create', playerId: '' },
  { type: 'character.create', playerId: 42 },
  { type: 'screen.look' },
  { type: 'screen.look', playerId: '' },
  { type: 'screen.look', playerId: 42 },
  { type: 'screen.map' },
  { type: 'screen.map', playerId: '' },
  { type: 'screen.map', playerId: USER, focus: 42 },
  { type: 'screen.map', playerId: USER, focus: {} },
  { type: 'screen.stats' },
  { type: 'screen.stats', playerId: 42 },
  { type: 'screen.backpack' },
  { type: 'screen.backpack', playerId: '' },
  { type: 'screen.journal' },
  { type: 'screen.journal', playerId: 42 },
  { type: 'screen.help' },
  { type: 'screen.help', playerId: '' },
  { type: 'warp.drive', playerId: USER },
];

describe('negative space (b)', () => {
  it('every garbage event → ok:false invalid-event, dispatch always resolves', async () => {
    for (const raw of GARBAGE_EVENTS) {
      const router = realRouter(new MockWorldEngine());
      const promise = router.dispatch(raw);
      await expect(promise).resolves.toBeDefined();
      const response = await promise;
      if (response.ok) throw new Error(`garbage event resolved ok:true: ${JSON.stringify(raw)}`);
      expect(response.error.code).toBe('invalid-event');
      expect(response.error.message.length).toBeGreaterThan(0);
    }
  });

  it('the validation gate runs before any backend call — a stub sees nothing', async () => {
    const stub = new StubBackend();
    const router = new GameRouter(stub, { idle: () => IDLE });
    await router.dispatch({ type: 'warp.drive', playerId: USER });
    await router.dispatch(null);
    await router.dispatch({ type: 'dayjob.start', playerId: USER, jobIndex: 'x' });
    expect(stub.calls).toEqual([]);
  });

  it('a hostile event whose getter throws during validation → ok:false invalid-event, never a rejection', async () => {
    const hostile: unknown = {
      type: 'menu.open',
      get playerId(): string { throw new Error('boom'); },
    };
    const router = realRouter(new MockWorldEngine());
    const promise = router.dispatch(hostile);
    await expect(promise).resolves.toBeDefined();
    const response = await promise;
    if (response.ok) throw new Error('hostile event resolved ok:true');
    expect(response.error.code).toBe('invalid-event');
    expect(response.error.message).toBe('boom');
  });
});

// ── Round-trip (c) — the seam is JSON even in-process; drive() already asserts this for
// every emitted view, so this test spot-checks a full rich flow end to end. ──

describe('round-trip (c)', () => {
  it('a full day-job flow (both beats + final outcome view) survives stringify/parse deep-equal', async () => {
    const engine = realChar();
    engine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
    engine.setStartActionResult(RESOLVED_WORK);
    const { response, beats } = await drive(realRouter(engine), DAYJOB_START(0));

    for (const beat of beats) {
      if (!beat.ok) throw new Error('beat must be ok:true');
      expect(roundTrip(beat.view)).toEqual(beat.view);
    }
    if (!response.ok) throw new Error('expected ok:true');
    expect(roundTrip(response.view)).toEqual(response.view);
    expect(roundTrip(response.facts)).toEqual(response.facts);
  });

  it('a full wizard walk through the real backend (step 1 → 8) round-trips every WizardViewState variant, and the created arm round-trips its facts', async () => {
    // The canned char stands in for the created row (the mock does not persist
    // createCharacter into getCharacter — M7.0 review note 3); characterExists stays
    // false, so the walk itself is unblocked.
    const wizards = new WizardSession();
    const router = realRouter(realChar({ dayJob: 'Town Guard' }), wizards);

    // Step 1 (join.open) and step 2 (answer) — drive() already asserts the round-trip.
    const start = await drive(router, JOIN_OPEN);
    assertWizardStep1(expectOkView(start.response, 'wizard'));
    if (!start.response.ok) throw new Error('unreachable');
    expect(roundTrip(start.response.view)).toEqual(start.response.view);

    const answered = await drive(router, WIZARD_ANSWER);
    assertWizardOptionStep(expectOkView(answered.response, 'wizard'));
    if (!answered.response.ok) throw new Error('unreachable');
    expect(roundTrip(answered.response.view)).toEqual(answered.response.view);

    for (const [step, value] of [[2, 'Warrior'], [3, 'Soldier'], [4, 'Human'], [5, 'lawful good'], [6, 'Town Guard']] as const) {
      const chosen = await drive(router, WIZARD_CHOOSE(step, value));
      assertWizardOptionStep(expectOkView(chosen.response, 'wizard'));
      if (!chosen.response.ok) throw new Error('unreachable');
      expect(roundTrip(chosen.response.view)).toEqual(chosen.response.view);
    }

    // Step 7 lands the step-8 confirm screen — and the stub's canned step-8 fixture
    // satisfies the same structural asserts as this real composition (interchangeability).
    assertWizardStep8(wizardStep8View);
    const kit = await drive(router, WIZARD_CHOOSE(7, "Soldier's Kit"));
    const review = expectOkView(kit.response, 'wizard');
    expect((review as WizardViewState).step).toBe(8);
    assertWizardStep8(review);
    if (!kit.response.ok) throw new Error('unreachable');
    expect(roundTrip(kit.response.view)).toEqual(kit.response.view);

    const created = await drive(router, CHARACTER_CREATE);
    expectOkView(created.response, 'notice');
    if (!created.response.ok) throw new Error('unreachable');
    expect(roundTrip(created.response.view)).toEqual(created.response.view);
    expect(roundTrip(created.response.facts)).toEqual(created.response.facts);
  });
});

// ── Beats (d): order, conformance, single idle draw, and a throwing onBeat never escapes ──

describe('beats (d)', () => {
  it('dayjob.start with commute: loading then commute, ONE idle() draw shared by both beats', async () => {
    const engine = realChar();
    engine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
    engine.setStartActionResult(RESOLVED_WORK);

    let idleDraws = 0;
    const controller = new SessionController(engine, () => SCENE, DAY_JOBS, undefined, new WizardSession(), REAL_DEFS, SCENE_STUB);
    const router = new GameRouter(controller, { idle: () => { idleDraws += 1; return IDLE; } });
    const { beats } = await drive(router, DAYJOB_START(0));

    expect(idleDraws).toBe(1);
    expect(beats).toHaveLength(2);
    expect(okView(beats[0])).toEqual({ screen: 'loading', body: `⏳ **Starting…**\n_${IDLE}_` });
    expect(okView(beats[1])).toEqual({ screen: 'commute', destination: 'The Town Gate', idle: IDLE });
  });

  it('action.custom clips the 280-char text in the beat, but the backend gets the full text', async () => {
    const engine = realChar();
    engine.setStartActionResult(DECISION_QUEST);
    const longText = 's'.repeat(300);
    const { beats } = await drive(realRouter(engine), { type: 'action.custom', playerId: USER, text: longText });

    expect(beats).toHaveLength(1);
    const body = okView(beats[0]) as { body: string } | undefined;
    expect(body?.body).toBe(`**You:** ${'s'.repeat(279)}…\n\n⏳ **Thinking…**\n_${IDLE}_`);
    expect(body?.body.includes('s'.repeat(300))).toBe(false);
    expect(engine.calls.startAction[0].rawInput).toBe(longText);
  });

  it('a throwing onBeat does not escape dispatch: every beat is still delivered, the final envelope returns', async () => {
    const engine = realChar();
    engine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
    engine.setStartActionResult(RESOLVED_WORK);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const router = realRouter(engine);
      const beats: GameResponse[] = [];
      const promise = router.dispatch(DAYJOB_START(0), (beat) => {
        beats.push(beat);
        throw new Error('paint boom');
      });
      await expect(promise).resolves.toBeDefined();
      const response = await promise;

      expect(beats).toHaveLength(2); // the flow continued past the throw
      expect(response.ok).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(2); // one console.error per onBeat throw
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('menu.open and feedback.submit emit no beats at all', async () => {
    const router = realRouter(realChar());
    const beats: GameResponse[] = [];
    await router.dispatch(MENU_OPEN, (beat) => beats.push(beat));
    await router.dispatch(FEEDBACK('sleep'), (beat) => beats.push(beat));
    expect(beats).toEqual([]);
  });
});

// ── Error path (e): backend throws → ok:false internal, never a rejection; a throwing
// recordFeedback still returns the confirmation envelope. ──

describe('error path (e)', () => {
  it('a scripted backend throw → internal, and the promise never rejects (stub runWork, real startAction)', async () => {
    const stub = stubRouter((s) => {
      s.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
      s.workResult = 'throw';
    });
    const stubPromise = stub.dispatch(DAYJOB_START(0));
    await expect(stubPromise).resolves.toBeDefined();
    expectInternal(await stubPromise);

    const real = realRouter(realChar()); // no canned startActionResult → runWork throws
    const realPromise = real.dispatch(DAYJOB_START(0));
    await expect(realPromise).resolves.toBeDefined();
    expectInternal(await realPromise);
  });

  it('a throwing stampLastPlayed → internal, never a rejection (the stub stampResult:throw script)', async () => {
    const stub = new StubBackend();
    stub.stampResult = 'throw';
    const router = new GameRouter(stub, { idle: () => IDLE });
    const promise = router.dispatch(MENU_OPEN);
    await expect(promise).resolves.toBeDefined();
    expectInternal(await promise);
  });

  it('a throwing recordFeedback still returns the confirmation envelope (best-effort persist), and carries the persistFailed fact (DC-M9.3.10 — the four dispatcher leaves read it to keep notifyAdmin firing)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stub = new StubBackend();
      stub.recordResult = 'throw';
      const router = new GameRouter(stub, { idle: () => IDLE });
      const promise = router.dispatch(FEEDBACK('sleep'));
      await expect(promise).resolves.toBeDefined();
      const response = await promise;

      expect(response.ok).toBe(true);
      if (response.ok) expect(response.view).toMatchObject({ screen: 'notice' });
      expect(response.ok && response.facts?.persistFailed).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1); // the router's own console.error survives alongside the fact
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a successful recordFeedback carries NO persistFailed fact (DC-M9.3.10 — absent matters as much as present)', async () => {
    const stub = new StubBackend();
    stub.recordResult = 'ok';
    const router = new GameRouter(stub, { idle: () => IDLE });
    const response = await router.dispatch(FEEDBACK('sleep'));

    expect(response.ok).toBe(true);
    expect(response.ok && response.facts?.persistFailed).toBeUndefined();
  });

  it('a throwing feedbackConfirmation → internal (stub-only: the real backend cannot throw here)', async () => {
    const stub = new StubBackend();
    stub.confirmationResult = 'throw';
    const router = new GameRouter(stub, { idle: () => IDLE });
    const promise = router.dispatch(FEEDBACK('sleep'));
    await expect(promise).resolves.toBeDefined();
    expectInternal(await promise);
  });

  it('a malformed backend view is converted to internal by the self-validation barrier (stub-only)', async () => {
    const stub = new StubBackend();
    stub.customResult = { kind: 'start' };
    // A backend can hand the router a structurally broken view; the settle's barrier must
    // keep it off the seam — the final envelope becomes ok:false internal with the
    // validator's message instead of the malformed ok:true.
    stub.customWorkResult = { kind: 'decision', view: { screen: 'bogus' } as never };
    const router = new GameRouter(stub, { idle: () => IDLE });
    const promise = router.dispatch(ACTION_CUSTOM);
    await expect(promise).resolves.toBeDefined();
    expectInternal(assertValid(await promise));
  });

  it('a backend throwing a hostile unstringable value → internal with [unstringable error], never a rejection', async () => {
    const stub = new StubBackend();
    stub.dayJobResult = { kind: 'ok', workplace: 'The Town Gate', workPrompt: 'p', wage: 5 };
    stub.workResult = 'throw';
    stub.throwValue = { [Symbol.toPrimitive]() { throw new Error('x'); } };
    const router = new GameRouter(stub, { idle: () => IDLE });
    const promise = router.dispatch(DAYJOB_START(0));
    await expect(promise).resolves.toBeDefined();
    const response = await promise;
    if (response.ok) throw new Error('expected ok:false internal, got ok:true');
    expect(response.error.code).toBe('internal');
    expect(response.error.message).toBe('[unstringable error]');
  });
});

// ── Persist side-effects on the REAL backend (the confirmation copy is reply-first; the
// persist is the engine call that follows it). ──

describe('real backend — feedback/bug persist routing', () => {
  it('feedback.submit sleep → submitFeedback with no actionId', async () => {
    const engine = realChar();
    await drive(realRouter(engine), FEEDBACK('sleep'));
    expect(engine.calls.submitFeedback).toEqual([{ characterId: 1, text: 'loving the atmosphere', actionId: undefined }]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('feedback.submit outcome-feedback with actionId → submitFeedback with the actionId', async () => {
    const engine = realChar();
    await drive(realRouter(engine), FEEDBACK('outcome-feedback', 42));
    expect(engine.calls.submitFeedback).toEqual([{ characterId: 1, text: 'loving the atmosphere', actionId: 42 }]);
  });

  it('bug.submit with actionId → submitBug with the actionId', async () => {
    const engine = realChar();
    await drive(realRouter(engine), BUG(7));
    expect(engine.calls.submitBug).toEqual([{ characterId: 1, text: 'the door is stuck', actionId: 7 }]);
    expect(engine.calls.submitFeedback).toEqual([]);
  });

  it('feedback/bug with no character → no engine call, confirmation still returned', async () => {
    const engine = new MockWorldEngine();
    await drive(realRouter(engine), FEEDBACK('sleep'));
    await drive(realRouter(engine), BUG(7));
    expect(engine.calls.submitFeedback).toEqual([]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('feedback.submit slash-feedback → submitFeedback with no actionId (DC-M9.5, same routing as sleep/release)', async () => {
    const engine = realChar();
    await drive(realRouter(engine), FEEDBACK('slash-feedback'));
    expect(engine.calls.submitFeedback).toEqual([{ characterId: 1, text: 'loving the atmosphere', actionId: undefined }]);
    expect(engine.calls.submitBug).toEqual([]);
  });

  it('bug.submit slash-bug → submitBug with no actionId (DC-M9.5, matching commands/bug.ts today)', async () => {
    const engine = realChar();
    await drive(realRouter(engine), BUG_SURFACE('slash-bug'));
    expect(engine.calls.submitBug).toEqual([{ characterId: 1, text: 'the door is stuck', actionId: undefined }]);
    expect(engine.calls.submitFeedback).toEqual([]);
  });

  it('slash-feedback/slash-bug with no character → the router guards BEFORE any engine call (DC-M9.5, unlike the other surfaces)', async () => {
    const engine = new MockWorldEngine();
    await drive(realRouter(engine), FEEDBACK('slash-feedback'));
    await drive(realRouter(engine), BUG_SURFACE('slash-bug'));
    expect(engine.calls.submitFeedback).toEqual([]);
    expect(engine.calls.submitBug).toEqual([]);
  });
});

// ── Barrier summary: one dispatch per reachable error code and per ViewState variant,
// driven through the REAL backend, so a dropped branch is a failing test rather than a
// reviewed diff (the M5.1 checklist's "every reachable error code + every ViewState
// variant"). ──

describe('barrier coverage (M5.1 checklist)', () => {
  it('reaches every GameErrorCode through the real backend', async () => {
    const codes = new Set<GameErrorCode>();

    codes.add(errorCodeOf(await drive(realRouter(new MockWorldEngine()), MENU_OPEN))); // no-character
    codes.add(errorCodeOf(await drive(realRouter(realChar({ rollsRemaining: 0 })), MENU_OPEN))); // no-rolls

    const staleEngine = realChar({ lastActionState: IN_FLIGHT as never });
    staleEngine.setResumeResult({
      state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'quest' },
      nextDecision: { prompt: 'Cold.', options: [] },
    });
    codes.add(errorCodeOf(await drive(realRouter(staleEngine), MENU_OPEN))); // stale-session

    const expiredEngine = realChar();
    expiredEngine.setPendingChoiceOptions([]);
    codes.add(errorCodeOf(await drive(realRouter(expiredEngine), ACTION_CHOOSE))); // session-expired

    codes.add(errorCodeOf(await drive(realRouter(realChar()), DAYJOB_START(5)))); // illegal-move

    const unsafeEngine = realChar({ location: 'The Dark Woods' });
    unsafeEngine.setLocation({ name: 'The Dark Woods', description: 'Spiders.', tags: [], isSafe: false, emoji: '🌲' });
    codes.add(errorCodeOf(await drive(realRouter(unsafeEngine), DAYJOB_START(0)))); // unsafe

    const emptyEngine = realChar();
    emptyEngine.setCommuteResult(null);
    emptyEngine.setStartActionResult({
      state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'work' },
      firstDecision: { prompt: '', options: [] },
      actionType: 'other',
    });
    codes.add(errorCodeOf(await drive(realRouter(emptyEngine), DAYJOB_START(0)))); // empty-action

    codes.add(errorCodeOf(await drive(realRouter(new MockWorldEngine()), null))); // invalid-event

    codes.add(errorCodeOf(await drive(realRouter(realChar()), DAYJOB_START(0)))); // internal — startAction throws

    const divineEngine = realChar();
    divineEngine.setCommuteResult(null);
    divineEngine.setStartActionResult(DIVINE_WORK);
    codes.add(errorCodeOf(await drive(realRouter(divineEngine), DAYJOB_START(0)))); // divine-intervention

    expect([...codes].sort()).toEqual([
      'divine-intervention', 'empty-action', 'illegal-move', 'internal', 'invalid-event',
      'no-character', 'no-rolls', 'session-expired', 'stale-session', 'unsafe',
    ]);
  });

  it('emits every ViewState variant (final + beats)', async () => {
    const screens = new Set<string>();

    const menu = await drive(realRouter(realChar()), MENU_OPEN);
    if (menu.response.ok && menu.response.view) screens.add(menu.response.view.screen);

    const resumeEngine = realChar({ lastActionState: IN_FLIGHT as never });
    resumeEngine.setResumeResult({
      state: { rawInput: 'x', decisions: [], accumulatedDc: 0, kind: 'quest' },
      nextDecision: {
        prompt: 'Fork?',
        options: [
          { label: 'Left', dcModifier: 0 },
          { label: 'Right', dcModifier: 1 },
        ],
      },
    });
    const decision = await drive(realRouter(resumeEngine), MENU_OPEN);
    if (decision.response.ok && decision.response.view) screens.add(decision.response.view.screen);

    const workEngine = realChar();
    workEngine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
    workEngine.setStartActionResult(RESOLVED_WORK);
    const work = await drive(realRouter(workEngine), DAYJOB_START(0));
    if (work.response.ok && work.response.view) screens.add(work.response.view.screen);
    for (const beat of work.beats) {
      if (beat.ok && beat.view) screens.add(beat.view.screen);
    }

    const notice = await drive(realRouter(realChar()), FEEDBACK('sleep'));
    if (notice.response.ok && notice.response.view) screens.add(notice.response.view.screen);

    const wizard = await drive(realRouter(new MockWorldEngine()), WIZARD_RESTART);
    if (wizard.response.ok && wizard.response.view) screens.add(wizard.response.view.screen);

    expect([...screens].sort()).toEqual(['commute', 'decision', 'loading', 'menu', 'notice', 'outcome', 'wizard']);
  });
});

// ── M8.5 stage 8 (DC-S5) — choice fidelity over the agent stream. The recorded deterministic
// event-stream fixture is generated IN-PROCESS at test time (a stubRun(1) session's protocol
// log — the stage-9 smoke pattern), so record and replay share the same wall-clock (SF3's
// same-weekday-class caveat is sidestepped) and the M8.5-corpus location stays a stage-9
// decision. Legality is routed through replay.ts's validated machinery (replayLog runs
// validateGameEvent + validateGameResponse + the DC-S5 sequence sanity on every entry) — never
// reimplemented here; this describe adds the contract suite's own command on top: every
// envelope the stream produces is in its event's allowed response set, and the stream replays
// through BOTH backends. ──

const streamDispatches = (protocol: ProtocolEntry[]): ProtocolDispatchEntry[] =>
  protocol.filter((e): e is ProtocolDispatchEntry => e.kind === 'dispatch');

describe('choice fidelity (agent stream) — DC-S5 (M8.5 stage 8)', () => {
  // The fixture: a deterministic stub session's protocol log, JSON-round-tripped (the file's
  // exact shape — the suite's round-trip convention). Byte-deterministic across fresh runs
  // (the stub-run dogfood pin), so the describe's assertions are stable.
  let fixture: ProtocolEntry[];

  beforeAll(async () => {
    const run = await stubRun(1);
    fixture = JSON.parse(JSON.stringify(run.harness.transcript.protocol)) as ProtocolEntry[];
    expect(streamDispatches(fixture).length).toBeGreaterThan(0);
  });

  // The per-event allowed view-screen families (DC-S5: "every envelope is in that event's
  // allowed response set" — the ok-branch screens the case tables above pin; error envelopes
  // carry no view). The fixture stream is all-ok, so the screens are the whole assertion.
  const ALLOWED_SCREENS: Record<string, ReadonlyArray<string>> = {
    'join.open': ['wizard'],
    'wizard.answer': ['wizard'],
    'wizard.choose': ['wizard'],
    'wizard.restart': ['wizard'],
    'character.create': ['notice'],
    'hi.open': ['notice'],
    'rest.begin': ['notice'],
    'screen.look': ['notice'],
    'screen.stats': ['notice'],
    'menu.open': ['menu', 'decision'],
    'dayjob.start': ['decision', 'outcome'],
    'action.custom': ['decision', 'outcome'],
    'action.choose': ['decision', 'outcome'],
  };

  it('the fixture is a legal stream — every recorded envelope is in its event\'s allowed response set', () => {
    for (const entry of streamDispatches(fixture)) {
      const check = validateGameResponse(entry.response);
      if (!check.ok) {
        throw new Error(`seq ${entry.seq} (${entry.event.type}) envelope failed validation: ${check.message}`);
      }
      expect(check.response.v, `seq ${entry.seq} (${entry.event.type})`).toBe(PROTOCOL_VERSION);
      if (check.response.ok) {
        expect(check.response.view, `seq ${entry.seq} (${entry.event.type}): ok:true must carry a view`).toBeDefined();
      }
      assertViewConformance(check.response);
      assertFactsRoundTrip(check.response);
      if (check.response.ok && check.response.view) {
        const allowed = ALLOWED_SCREENS[entry.event.type];
        if (!allowed) throw new Error(`seq ${entry.seq} (${entry.event.type}) has no allowed-screen family`);
        expect(allowed).toContain(check.response.view.screen);
      }
    }
  });

  it('the fixture replays byte-equal through the stub backend (DC-S2: every event legal, every envelope matched)', async () => {
    const result = await replayLog(fixture);
    expect(result.fatal).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entries.every((e) => e.ok)).toBe(true);
  });

  it('the fixture replays through the real backend with the choice-fidelity invariants holding (the interchangeability proof)', async () => {
    const result = await replayLog(fixture, { backend: 'real' });
    expect(result.fatal).toBeUndefined();
    // The header records 'stub'; the forced real arm is honored with a warning, never silent.
    expect(result.warnings.some((w) => w.includes("'stub'") && w.includes('forces'))).toBe(true);
    // Zero validation failures: every event validates (validateGameEvent) AND the DC-S5
    // sequence sanity holds — the next event is legal for the returned view, re-seeding
    // through the recorded creation walk on the fresh engine included.
    expect(result.entries.every((e) => e.validationError === undefined)).toBe(true);

    // The one recorded structural divergence: the canned script idealizes rest (always
    // rested ok:true) while the real engine correctly rejects resting with rolls unspent
    // (the stub day's flows consume no rolls in the script). Pinned explicitly so a future
    // fixture change that makes the stub day roll-faithful updates this pin with it.
    const restBegin = result.entries.find((e) => e.eventType === 'rest.begin');
    if (!restBegin) throw new Error('the stream must carry a rest.begin entry');
    expect(restBegin.ok).toBe(false);
    expect(restBegin.validationError).toBeUndefined();
    // M9.3.2c (DC-M9.6), declared churn class 5: the live rejection now carries a narrow
    // `nav` fact (the illegal-move guard arm feeds the dispatcher's `/sleep` nav weld), so
    // the single 'response.facts: missing in live' line resolves into a field-by-field
    // comparison against the recorded 'rested' arm's fuller facts. This array is a DERIVED
    // diff: the structural claim under it — canned script rests, real engine rejects with
    // rolls unspent — is unchanged, and the corpus fixture is untouched.
    expect([...(restBegin.diff ?? [])].sort()).toEqual([
      'response.error: missing in recorded',
      'response.facts.characterClass: missing in live',
      'response.facts.characterName: missing in live',
      'response.facts.characterState: missing in live',
      'response.facts.nav.rollsRemaining: 1 !== 3',
      'response.ok: false !== true',
      'response.view: missing in live',
    ]);

    // Structural fidelity everywhere else: the real engine's envelopes match the recorded
    // stub envelopes in every envelope-level field — ok/error/view presence and the view
    // screen. Diffs may touch view content and facts VALUES only (different character
    // profiles); a screen, ok, error-code, or validator divergence is an interchangeability
    // breach, not fixture noise.
    for (const entry of result.entries) {
      if (entry.ok || entry === restBegin) continue;
      const diffs = entry.diff ?? [];
      expect(diffs.length, `seq ${entry.seq} (${entry.eventType}) should carry content diffs`).toBeGreaterThan(0);
      for (const d of diffs) {
        expect(
          d.startsWith('response.view.') || d.startsWith('response.facts.'),
          `seq ${entry.seq} (${entry.eventType}): structural diff ${JSON.stringify(d)}`,
        ).toBe(true);
        expect(d).not.toContain('response.view.screen');
        expect(d).not.toContain('failed its own validator');
      }
    }
  });
});
