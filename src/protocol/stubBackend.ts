/**
 * The contract suite's canned stub RouterBackend (DC-P7) + its canned fixtures, extracted
 * from tests/protocol/contract.test.ts at M8.5 stage 5 (DC-S2, the StubBackend extraction)
 * into this shared non-test module — ONE source of truth for the scriptable backend the
 * seam's interchangeability contract is asserted against: the contract suite imports it
 * from here, and the M8.5 smoke tooling (npm run agent:stub, agent:replay) uses the same
 * class + fixtures. The class body and every fixture are verbatim lifts from the contract
 * suite — byte-green after the move, no value edits.
 *
 * Non-imports per the Home rule (DC-P8): like the router, this module imports nothing from
 * discord.js, src/discord/ or src/agent/ — controller/engine/view types only (type-only,
 * erased at runtime). The runtime MockWorldEngine import is the recorded src→src exception
 * (stubChar = MockWorldEngine.defaultCharacter(...)), the same wiring the contract suite
 * used before the move.
 */

import type { RouterBackend } from './router.js';
import { MockWorldEngine } from '../engine/MockWorldEngine.js';
import type {
  ActionMenuResult,
  BeginChoiceResult,
  BeginCustomActionResult,
  DayJobStart,
  FeedbackSurface,
  HelpOpenResult,
  HiOpenResult,
  JoinOpenResult,
  RestBeginResult,
  ScreenOpenResult,
  StartRenderResult,
  StepChoiceResult,
  WizardAnswerResult,
  WizardConfirmResult,
  WizardOptionResult,
  WizardRestartResult,
} from '../controller/SessionController.js';
import type { CharacterData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { DecisionViewState, NoticeViewState, OutcomeViewState, WizardViewState } from '../view/viewState.js';

// ── Canned fixtures (verbatim from tests/protocol/contract.test.ts, M8.5 stage 5) ──

export const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

export const decisionView: DecisionViewState = {
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

export const outcomeView: OutcomeViewState = {
  screen: 'outcome',
  title: { emoji: '💰', text: 'Scout' },
  colorIntent: 'success',
  isCombat: false,
  outcomeBlock: 'You earned 5 silver.',
};

export const noticeView: NoticeViewState = { screen: 'notice', text: '🙏 Thanks. The warden listens.', ephemeral: true };

export const stubChar: CharacterData = MockWorldEngine.defaultCharacter({ dayJob: 'Town Guard' });

export const SCREEN_VIEWS: Record<'look' | 'map' | 'stats' | 'backpack' | 'journal' | 'help', NoticeViewState> = {
  look: { screen: 'notice', text: ["```", '...', '```', '', "🌳 **The Warden's Oak**"].join('\n'), ephemeral: true },
  map: { screen: 'notice', text: '🏠 **The Vale**\n🗺️ The roads you know.', ephemeral: true },
  stats: { screen: 'notice', text: '🗡️  **Aldric** — Warrior', ephemeral: true },
  backpack: { screen: 'notice', text: '🎒 **Backpack** (0/40)', ephemeral: true },
  journal: { screen: 'notice', text: "📖 **Aldric's Journal**", ephemeral: true },
  help: { screen: 'notice', text: "📜 **The Warden's Oak — Command List**", ephemeral: true },
};

export const wizardStep1View: WizardViewState = {
  screen: 'wizard',
  step: 1,
  totalSteps: 7,
  ledger: '📝 **Name** ◀\n🛡️ Class\n🌱 Upbringing\n🧬 Race\n⚖️ Alignment\n🔧 Day Job\n🎒 Starting Kit',
  body: '__**Name**__\nWhat shall the songs call you?',
  footer: 'Step 1 of 7 — 2-30 characters, no @ or #',
  nameField: { label: 'Character Name', placeholder: 'Enter a name (2-30 characters)', minLength: 2, maxLength: 30 },
  buttons: [{ kind: 'name', label: 'Enter Name', emoji: '📝' }],
};

/** A generic mid-walk (steps 2-7) wizard view — the stub scripts it for answer/choose ok. */
export function wizardStepNView(step: number): WizardViewState {
  return {
    screen: 'wizard',
    step,
    totalSteps: 7,
    ledger: '📝 ~~Name~~ → **Rowan**\n🛡️ ~~Class~~ → 🗡️ **Warrior**\n🌱 **Upbringing** ◀',
    body: '__**Upbringing**__\n🎖️ **Soldier**\nRaised in a military family. Discipline was your first language.',
    footer: `Step ${step} of 7 — Upbringing`,
    options: [{ value: 'Soldier', label: 'Soldier', emoji: '🎖️' }],
    buttons: [
      { kind: 'choice', step, value: 'Soldier', label: 'Soldier', emoji: '🎖️' },
      { kind: 'restart', label: 'Start Over', emoji: '🔄' },
    ],
  };
}

export const wizardStep8View: WizardViewState = {
  screen: 'wizard',
  step: 8,
  totalSteps: 7,
  ledger: '📝 ~~Name~~ → **Rowan**\n🛡️ ~~Class~~ → 🗡️ **Warrior**\n🌱 ~~Upbringing~~ → 🎖️ **Soldier**\n🧬 ~~Race~~ → 🧑 **Human**\n⚖️ ~~Alignment~~ → 😇 **Lawful Good**\n🔧 ~~Day Job~~ → 🛡️ **Town Guard**\n🎒 ~~Starting Kit~~ → **Soldier\'s Kit**',
  body: '__**Ready**__\nYour hero stands ready. Confirm to step into the world — or start over.',
  footer: 'Review your choices and confirm',
  buttons: [
    { kind: 'confirm', label: 'Confirm', emoji: '✅' },
    { kind: 'restart', label: 'Start Over', emoji: '🔄' },
  ],
};

/** The stub's hi.open unfinished-action arm — prompt + narration, mirroring the real
 *  backend's resume compose. */
export const HI_RESUME: HiOpenResult = {
  kind: 'resume',
  view: {
    screen: 'notice',
    text: [
      '⏳ **Unfinished Action**',
      SEPARATOR,
      '',
      'You stand at the ridgeline, wind pulling at your cloak.',
      '',
      'The trail forks. Continue?',
      '',
      'Press the **Action** button to continue.',
    ].join('\n'),
    ephemeral: true,
  },
};

/** The stub's day-job outcome — observably equivalent to the real backend's (same
 *  distilledType/characterName/actionId and the same post-action char, hence the same nav). */
export const STUB_OUTCOME: StartRenderResult = {
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
export const STUB_STEP_OUTCOME: StepChoiceResult = {
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
// M8.5 stage 5 (DC-S2): extracted from tests/protocol/contract.test.ts into this shared
// module — the contract suite and the M8.5 tooling (agent:stub, agent:replay) import the
// same class + fixtures (one source of truth). Body is byte-identical to the suite's copy.

export class StubBackend implements RouterBackend {
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
  restResult: RestBeginResult | 'throw' = { kind: 'no-character' };
  hiResult: HiOpenResult | 'throw' = { kind: 'no-character' };
  // M8.1 screens (DC-M8.3) — scriptable results; the five gated default to the
  // no-character arm (the router's NO_CHARACTER_COPY case), help to its view arm.
  lookResult: ScreenOpenResult | 'throw' = { kind: 'no-character' };
  mapResult: ScreenOpenResult | 'throw' = { kind: 'no-character' };
  statsResult: ScreenOpenResult | 'throw' = { kind: 'no-character' };
  backpackResult: ScreenOpenResult | 'throw' = { kind: 'no-character' };
  journalResult: ScreenOpenResult | 'throw' = { kind: 'no-character' };
  helpResult: HelpOpenResult | 'throw' = { kind: 'view', view: SCREEN_VIEWS.help };
  // M7.3 wizard scripts (DC-M7.3.11). The `join.open` call logs as 'startWizard' — the
  // DC-M7.3.11 flow-order pin's recorded name for the start-or-resume arm.
  joinResult: JoinOpenResult | 'throw' = { kind: 'view', view: wizardStep1View };
  answerResult: WizardAnswerResult | 'throw' = { kind: 'no-session' };
  chooseResult: WizardOptionResult | 'throw' = { kind: 'no-session' };
  restartResult: WizardRestartResult | 'throw' = { kind: 'view', view: wizardStep1View };
  confirmResult: WizardConfirmResult | 'throw' = { kind: 'no-session' };
  /** Step-specific wizard views a scripted walk can return (DC-M7.3.11). */
  wizardViews: Record<number, WizardViewState> = {};
  /** Overridable no-log read for addCharacterFacts' nav facts — lets a stub case mirror the
   *  real backend's mid-action character (DC-P7 observability, e.g. hasPendingAction) or the
   *  charless state (M8.1: the screen.help no-gate cases set this to null). */
  character: CharacterData | null = stubChar;
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
    return this.character;
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

  beginRest(_userId: string): RestBeginResult {
    return this.run('beginRest', this.restResult);
  }

  openHi(_userId: string): HiOpenResult {
    return this.run('openHi', this.hiResult);
  }

  openLook(_userId: string): ScreenOpenResult {
    return this.run('openLook', this.lookResult);
  }

  openMap(_userId: string, _focus?: string): ScreenOpenResult {
    return this.run('openMap', this.mapResult);
  }

  openStats(_userId: string): ScreenOpenResult {
    return this.run('openStats', this.statsResult);
  }

  openBackpack(_userId: string): ScreenOpenResult {
    return this.run('openBackpack', this.backpackResult);
  }

  openJournal(_userId: string): ScreenOpenResult {
    return this.run('openJournal', this.journalResult);
  }

  openHelp(_userId: string): HelpOpenResult {
    return this.run('openHelp', this.helpResult);
  }

  openJoin(_userId: string): JoinOpenResult {
    return this.run('startWizard', this.joinResult);
  }

  answerWizardName(_userId: string, _text: string): WizardAnswerResult {
    return this.run('answerWizardName', this.answerResult);
  }

  chooseWizardOption(_userId: string, _step: number, _value: string): WizardOptionResult {
    return this.run('chooseWizardOption', this.chooseResult);
  }

  restartWizard(_userId: string): WizardRestartResult {
    return this.run('restartWizard', this.restartResult);
  }

  confirmWizard(_userId: string): WizardConfirmResult {
    return this.run('confirmWizard', this.confirmResult);
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
