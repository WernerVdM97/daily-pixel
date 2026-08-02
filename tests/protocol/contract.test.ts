import { describe, it, expect, vi } from 'vitest';

import { GameRouter, type RouterBackend } from '../../src/protocol/router.js';
import { PROTOCOL_VERSION, validateGameResponse, type GameErrorCode, type GameResponse } from '../../src/protocol/envelope.js';
import { SessionController } from '../../src/controller/SessionController.js';
import type {
  ActionMenuResult,
  BeginChoiceResult,
  BeginCustomActionResult,
  DayJobStart,
  FeedbackSurface,
  StartRenderResult,
  StepChoiceResult,
} from '../../src/controller/SessionController.js';
import { MockWorldEngine } from '../../src/engine/MockWorldEngine.js';
import type { ActionOutcome, CharacterData, PendingChoiceSelector } from '../../src/engine/WorldEngine.js';
import type { DayJobDef } from '../../src/controller/dayJob.js';
import type { DecisionViewState, MenuViewState, NoticeViewState, OutcomeViewState, ViewState } from '../../src/view/viewState.js';

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

const decisionView: DecisionViewState = {
  screen: 'decision',
  title: { emoji: '🤔', text: 'Decision' },
  colorIntent: 'decision',
  prompt: '> The gate creaks. What do you do?',
  optionLines: ['**A.** Advance carefully'],
  buttons: [
    { kind: 'choice', letter: 'A', customId: 'action:choice:0:0', favoured: false },
    { kind: 'bail', label: 'Leave', customId: 'action:bail' },
  ],
  footer: 'What do you do?',
};

const outcomeView: OutcomeViewState = {
  screen: 'outcome',
  title: { emoji: '💰', text: 'Scout' },
  colorIntent: 'success',
  isCombat: false,
  outcomeBlock: 'You earned 5 silver.',
};

const menuView: MenuViewState = {
  screen: 'menu',
  title: { emoji: '🛠️', text: 'Town Guard — Daily Work' },
  description: 'Pick a task to start:',
  buttons: [
    { label: 'Walk the rounds', customId: 'action:dayjob:0', style: 'secondary' },
    { label: 'Custom…', customId: 'action:dayjob:custom', style: 'primary' },
  ],
};

const noticeView: NoticeViewState = { screen: 'notice', text: '🙏 Thanks. The warden listens.', ephemeral: true };

const stubChar: CharacterData = MockWorldEngine.defaultCharacter({ dayJob: 'Town Guard' });

/** The stub's day-job outcome — observably equivalent to the real backend's (same
 *  distilledType/characterName/actionId and the same post-action char, hence the same nav). */
const STUB_OUTCOME: StartRenderResult = {
  kind: 'outcome',
  viewPrivate: outcomeView,
  viewPublic: outcomeView,
  distilledType: 'scout',
  actionId: 77,
  characterName: 'Aldric',
  char: stubChar,
  prevChar: stubChar,
};

/** The stub's action.choose outcome — adds characterClass (only StepChoiceResult carries it). */
const STUB_STEP_OUTCOME: StepChoiceResult = {
  kind: 'outcome',
  view: outcomeView,
  distilledType: 'scout',
  actionId: 77,
  characterName: 'Aldric',
  characterClass: 'Warrior',
  char: stubChar,
  prevChar: stubChar,
};

// ── The canned stub backend (DC-P7) — the interchangeability proof. Every method logs its
// call (DC-P6 ordering assertions) and returns its scripted result; a 'throw' script
// exercises the internal-error path. Anything left unscripted returns a benign default. ──

class StubBackend implements RouterBackend {
  calls: string[] = [];
  confirmationSurfaces: FeedbackSurface[] = [];
  feedbackLog: Array<{ surface: FeedbackSurface; userId: string; text: string; actionId?: number }> = [];

  stampResult: 'ok' | 'throw' = 'ok';
  menuResult: ActionMenuResult | 'throw' = { kind: 'no-character' };
  dayJobResult: DayJobStart | 'throw' = { kind: 'no-character' };
  commuteResult: { kind: 'commuted'; destination: string } | { kind: 'none' } | 'throw' = { kind: 'none' };
  workResult: StartRenderResult | 'throw' = { kind: 'empty-action', prompt: 'Nothing to do.' };
  customResult: BeginCustomActionResult | 'throw' = { kind: 'no-character' };
  customWorkResult: StartRenderResult | 'throw' = { kind: 'empty-action', prompt: 'Nothing to do.' };
  choiceResult: BeginChoiceResult | 'throw' = { kind: 'no-character' };
  resolveResult: string | null | 'throw' = null;
  stepResult: StepChoiceResult | 'throw' = { kind: 'decision', view: decisionView };
  confirmationResult: NoticeViewState | 'throw' = noticeView;
  recordResult: 'ok' | 'throw' = 'ok';

  /** When a 'throw' script fires, the value to throw instead of the standard Error —
   *  exercises safeStringify on hostile non-Error throws. */
  throwValue: unknown = undefined;

  private run<T>(name: string, scripted: T | 'throw'): T {
    this.calls.push(name);
    if (scripted === 'throw') throw this.throwValue ?? new Error(`${name} boom`);
    return scripted;
  }

  getCharacter(_userId: string): CharacterData | null {
    return stubChar;
  }

  stampLastPlayed(_userId: string): void {
    this.calls.push('stampLastPlayed');
    if (this.stampResult === 'throw') throw new Error('stampLastPlayed boom');
  }

  openActionMenu(_userId: string): ActionMenuResult {
    return this.run('openActionMenu', this.menuResult);
  }

  beginDayJob(_userId: string, _idx: number): DayJobStart {
    return this.run('beginDayJob', this.dayJobResult);
  }

  commuteForWork(_userId: string, _workplace: string | null): { kind: 'commuted'; destination: string } | { kind: 'none' } {
    return this.run('commuteForWork', this.commuteResult);
  }

  async runWork(_userId: string, _workPrompt: string, _wage: number): Promise<StartRenderResult> {
    return this.run('runWork', this.workResult);
  }

  beginCustomAction(_userId: string): BeginCustomActionResult {
    return this.run('beginCustomAction', this.customResult);
  }

  async runCustomAction(_userId: string, _description: string): Promise<StartRenderResult> {
    return this.run('runCustomAction', this.customWorkResult);
  }

  beginChoice(_userId: string): BeginChoiceResult {
    return this.run('beginChoice', this.choiceResult);
  }

  resolveChoice(_character: CharacterData, _selector: PendingChoiceSelector): string | null {
    return this.run('resolveChoice', this.resolveResult);
  }

  async stepChoice(_userId: string, _label: string, _prevChar: CharacterData): Promise<StepChoiceResult> {
    return this.run('stepChoice', this.stepResult);
  }

  feedbackConfirmation(surface: FeedbackSurface): NoticeViewState {
    this.confirmationSurfaces.push(surface);
    return this.run('feedbackConfirmation', this.confirmationResult);
  }

  recordFeedback(surface: FeedbackSurface, userId: string, text: string, actionId?: number): void {
    this.calls.push('recordFeedback');
    this.feedbackLog.push({ surface, userId, text, actionId });
    if (this.recordResult === 'throw') throw new Error('recordFeedback boom');
  }
}

// ── Router factories ──

function realRouter(engine: MockWorldEngine): GameRouter {
  // The assignment is the runtime-side structural proof (DC-P7): SessionController must
  // satisfy RouterBackend or this line fails to compile. The typecheck-time proof lives
  // in src/protocol/router.ts (exported `SessionControllerSatisfiesRouterBackend`).
  const backend: RouterBackend = new SessionController(engine, () => SCENE, DAY_JOBS);
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
    name: 'backend throw → internal (real: unknown day job in composeActionMenu; stub: scripted throw)',
    event: MENU_OPEN,
    real: () => realRouter(realChar({ dayJob: 'Astronaut' })),
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
      s.workResult = STUB_OUTCOME;
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
});

// ── Beats (d): order, conformance, single idle draw, and a throwing onBeat never escapes ──

describe('beats (d)', () => {
  it('dayjob.start with commute: loading then commute, ONE idle() draw shared by both beats', async () => {
    const engine = realChar();
    engine.setCommuteResult({ to: 'The Town Gate', stamina: 9 });
    engine.setStartActionResult(RESOLVED_WORK);

    let idleDraws = 0;
    const router = new GameRouter(
      new SessionController(engine, () => SCENE, DAY_JOBS),
      { idle: () => { idleDraws += 1; return IDLE; } },
    );
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

  it('a throwing recordFeedback still returns the confirmation envelope (best-effort persist)', async () => {
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
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
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

    expect([...codes].sort()).toEqual([
      'empty-action', 'illegal-move', 'internal', 'invalid-event',
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

    expect([...screens].sort()).toEqual(['commute', 'decision', 'loading', 'menu', 'notice', 'outcome']);
  });
});
