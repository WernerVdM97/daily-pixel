/**
 * The M5.1 in-process event router (DC-P4/P5/P6/P7, see docs/engine/json-seam-protocol.md
 * § "M5 build plan (lead-settled 2026-08-02)"). This is the seam's only backend-facing
 * surface: it validates the incoming event, drives a `RouterBackend` (structurally the
 * SessionController surface) through the six M5 action-loop flows in today's exact leaf
 * order, and maps every controller result to a `GameResponse` envelope.
 *
 * The router owns ALL player-facing copy (DC-P4): the adapter keeps only medium chrome.
 * It never throws and never rejects — invalid events, illegal moves and backend throws all
 * come back as `ok: false` envelopes, and every `onBeat` invocation is try/caught so a
 * throwing adapter paint callback cannot escape the seam (settled onBeat semantics).
 *
 * Self-validation (lead settle, structural barrier): every envelope this router emits —
 * final AND each beat — is run through `validateGameResponse` before it crosses the seam.
 * A final envelope that fails its own validator becomes `ok:false 'internal'` carrying the
 * validation message; a beat that fails is dropped (beats are advisory) with a console.error.
 *
 * Non-imports per the Home rule (DC-P8): this module imports nothing from discord.js,
 * src/discord/ or src/agent/ — controller/engine types only (type-only, erased at runtime),
 * ViewState from src/view/viewState.js. The injected `idle: () => string` keeps adapter
 * dependencies out: the Discord adapter passes `randomIdleMessage` at M9; the agent and
 * the contract suite pass deterministic ones.
 */

import { PROTOCOL_VERSION, validateGameResponse, type GameErrorCode, type GameResponse } from './envelope.js';
import { validateGameEvent, type GameEvent } from './events.js';
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
  SessionController,
  StartRenderResult,
  StepChoiceResult,
  WizardAnswerResult,
  WizardConfirmResult,
  WizardOptionResult,
  WizardRestartResult,
} from '../controller/SessionController.js';
import type { CharacterData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { NoticeViewState } from '../view/viewState.js';
import { checkProfanity } from './profanity.js';

// ── Player-facing copy (DC-P4). The router owns every string below; the byte-identity
// recon (2026-08-02) split the two no-character copies by event because menu.open's
// callers (nav:action, slash /action) both use the "…yet." copy while the other events'
// call sites use "…first." — per-event canonical copy preserves every current paint. ──

const NO_CHARACTER_MENU_COPY = "You don't have a character yet. Type `/join` to create one.";
const NO_CHARACTER_COPY = "You don't have a character. Type `/join` first.";
const NO_ROLLS_COPY = "🛌 **Out of actions for today.**\nRest by the Oak (`/sleep`) and try again tomorrow.";
const INVALID_JOB_COPY = 'Invalid job action.';
const SESSION_EXPIRED_COPY = "❌ Your action session expired. Try `/action` again.";
const UNSAFE_COPY = (location: string): string =>
  `⚠️ **It's no place for honest work here.**\nThe ${location} is too dangerous — make for safer ground before you set to your trade.`;
// DC-M9.3.8: the guard's own module moved here with it (src/discord/profanity.ts →
// src/protocol/profanity.ts); this is the adapter's exact pre-move string.
const PROFANITY_COPY = "❌ That action contains language the warden won't tolerate. Try something else.";

// ── character.create flow copy (M7.3, DC-M7.3.6) — the four wizard copy constants. The
// wizard error copies carry NO ❌ — the handler paints them via safeNotify (`❌ ${message}`,
// M7.0 transcript 4's byte path); HAS_CHARACTER_COPY is painted via editReply (transcript
// 2's path, no ❌). HAS_CHARACTER_COPY is byte-pinned by transcript 2; WIZARD_NO_SESSION_COPY
// is new copy pinned by the new TTL transcript 17; WIZARD_ILLEGAL_CHOICE_COPY is pinned by
// the new illegal-choice transcript 19. ──

const HAS_CHARACTER_COPY = "You already have a character. Type `/stats` to see it.";
const WIZARD_NO_SESSION_COPY = "Your character creation session expired. Type `/join` to start over.";
const WIZARD_ILLEGAL_CHOICE_COPY = "That option is no longer available. Type `/join` to start over.";
const WIZARD_NOT_READY_COPY = "Character creation isn't ready to confirm. Type `/join` to start over.";

// ── rest.begin copy (M7.1, DC-M7.1.3) — the unsafe-rest −1 HP RULE moved into the engine
// (DC-M7.1.1); the ⚠️ penalty prose and the rest screen are copy that now lives here. The
// guard copies + composeRestCopy are byte-for-byte lifts of the old sleep.ts reply assembly
// — M7.0 bookend-oracle transcripts 12/14 and the M1 oracle's /sleep leaves pin them. ──

// protocol/ imports nothing from src/discord (the Home rule), so the format.ts separator
// constant is copied here; byte-identity is what the transcript net asserts.
const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

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

/** The /sleep rest screen — a byte-for-byte lift of the old sleep.ts reply assembly
 *  (DC-M7.1.3): header / SEPARATOR / locationLine by `alreadyThere`, the ⚠️ penalty section
 *  when the rest was unsafe, then the closing prose. The `(x/max ❤️)` suffix is always
 *  present on this path — the char guard precedes the engine call, so `updated` is never
 *  null when the controller returns the rested arm. */
function composeRestCopy(result: {
  alreadyThere: boolean;
  updated: CharacterData;
  wasUnsafe: boolean;
  unsafeFromName: string;
}): string {
  const penaltyLine = result.wasUnsafe
    ? [
        '⚠️ **Resting on unsafe ground costs 1 HP.**',
        `You bedded down at **${result.unsafeFromName}**, far from the Oak's protection — no safe fire, no walls, one eye open all night.`,
        '',
        `The night was rough — you lost **1 HP**. (${result.updated.health}/${result.updated.maxHealth} ❤️)`,
        '',
        '_Return to the Oak (or your workplace) **before** resting to avoid this._',
      ].join('\n')
    : '';

  const locationLine = result.alreadyThere
    ? "The Oak's familiar boughs cradle you once more."
    : 'You bank the fire and bed down beneath the Oak.';

  const lines: string[] = [
    "🏕️ **The Warden's Oak**",
    SEPARATOR,
    '',
    locationLine,
  ];
  if (penaltyLine) {
    lines.push(SEPARATOR);
    lines.push('');
    lines.push(penaltyLine);
  }
  lines.push(SEPARATOR);
  lines.push('');
  lines.push('The day turns when the world wills it — not when you do.');
  lines.push('');
  lines.push('*The ember glows. The Oak stands watch. Rest, for now.*');

  return lines.join('\n');
}

/** Extracts a message from an unknown thrown value and never throws itself — a hostile
 *  value (a Symbol.toPrimitive that throws) collapses to a fixed placeholder instead of
 *  escaping the seam's never-throws boundary. */
const safeStringify = (err: unknown): string => {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return '[unstringable error]';
  }
};

/** The controller surface the router calls (DC-P7) — exactly the SessionController methods
 *  the six flows need, signatures lifted verbatim so SessionController satisfies it
 *  structurally (the contract suite's real-backend wiring typechecks the assignment). The
 *  contract suite's canned stub is the interchangeability proof staying in M5 scope.
 *  Extended with `getCharacter` in M6.1 for the `characterState` fact (DC-M6.1). */
export interface RouterBackend {
  getCharacter(userId: string): CharacterData | null;
  stampLastPlayed(userId: string): void;
  openActionMenu(userId: string): ActionMenuResult;
  beginDayJob(userId: string, idx: number): DayJobStart;
  commuteForWork(userId: string, workplace: string | null): { kind: 'commuted'; destination: string } | { kind: 'none' };
  runWork(userId: string, workPrompt: string, wage: number): Promise<StartRenderResult>;
  beginCustomAction(userId: string): BeginCustomActionResult;
  runCustomAction(userId: string, description: string): Promise<StartRenderResult>;
  beginChoice(userId: string): BeginChoiceResult;
  resolveChoice(character: CharacterData, selector: PendingChoiceSelector): string | null;
  stepChoice(userId: string, label: string, prevChar: CharacterData): Promise<StepChoiceResult>;
  beginRest(userId: string): RestBeginResult;
  openHi(userId: string): HiOpenResult;
  openLook(userId: string): ScreenOpenResult;
  openMap(userId: string, focus?: string): ScreenOpenResult;
  openStats(userId: string): ScreenOpenResult;
  openBackpack(userId: string): ScreenOpenResult;
  openJournal(userId: string): ScreenOpenResult;
  openHelp(userId: string): HelpOpenResult;
  openJoin(userId: string): JoinOpenResult;
  answerWizardName(userId: string, text: string): WizardAnswerResult;
  chooseWizardOption(userId: string, step: number, value: string): WizardOptionResult;
  restartWizard(userId: string): WizardRestartResult;
  confirmWizard(userId: string): WizardConfirmResult;
  feedbackConfirmation(surface: FeedbackSurface): NoticeViewState;
  recordFeedback(surface: FeedbackSurface, userId: string, text: string, actionId?: number): void;
}

/** Type-level proof of the DC-P7 interchangeability contract: SessionController satisfies
 *  RouterBackend structurally, or `npm run typecheck` fails. The interface mirrors the
 *  controller surface instead of extending it so the test stub can be canned without
 *  inheriting controller behaviour. (Exported so it is part of the typechecked surface.) */
export type SessionControllerSatisfiesRouterBackend = SessionController extends RouterBackend ? true : never;

export interface GameRouterDeps {
  /** One idle string per dispatch (DC-P5) — threaded into every beat of that dispatch,
   *  matching today's single `randomIdleMessage()` call per flow. */
  idle: () => string;
}

export class GameRouter {
  constructor(
    private readonly backend: RouterBackend,
    private readonly deps: GameRouterDeps,
  ) {}

  /** Validates, dispatches, maps — and never throws or rejects. Beats (loading/commute/
   *  thinking interstitials) are advisory; the returned envelope is authoritative. */
  async dispatch(event: unknown, onBeat?: (beat: GameResponse) => void): Promise<GameResponse> {
    // Lazy single draw: idle() runs at most once per dispatch, only when a beat needs it.
    let idle: string | undefined;
    const idleOnce = (): string => {
      if (idle === undefined) idle = this.deps.idle();
      return idle;
    };

    try {
      const gate = this.validateEvent(event);
      if (!gate.ok) return this.error('invalid-event', gate.message);

      const e = gate.event;
      switch (e.type) {
        case 'menu.open':
          return await this.dispatchMenuOpen(e);
        case 'dayjob.start':
          return await this.dispatchDayJobStart(e, onBeat, idleOnce);
        case 'action.custom':
          return await this.dispatchActionCustom(e, onBeat, idleOnce);
        case 'action.choose':
          return await this.dispatchActionChoose(e, onBeat, idleOnce);
        case 'feedback.submit':
          return await this.dispatchFeedback(e.surface, e.playerId, e.text, e.actionId);
        case 'bug.submit':
          return await this.dispatchFeedback(e.surface ?? 'outcome-bug', e.playerId, e.text, e.actionId);
        case 'rest.begin':
          return this.dispatchRestBegin(e);
        case 'hi.open':
          return this.dispatchHiOpen(e);
        case 'join.open':
          return this.dispatchJoinOpen(e);
        case 'wizard.answer':
          return this.dispatchWizardAnswer(e);
        case 'wizard.choose':
          return this.dispatchWizardChoose(e);
        case 'wizard.restart':
          return this.dispatchWizardRestart(e);
        case 'character.create':
          return this.dispatchCharacterCreate(e);
        case 'screen.look':
          return this.dispatchScreenLook(e);
        case 'screen.map':
          return this.dispatchScreenMap(e);
        case 'screen.stats':
          return this.dispatchScreenStats(e);
        case 'screen.backpack':
          return this.dispatchScreenBackpack(e);
        case 'screen.journal':
          return this.dispatchScreenJournal(e);
        case 'screen.help':
          return this.dispatchScreenHelp(e);
      }
    } catch (err) {
      return this.internalError(err);
    }
  }

  /** The gate runs inside the never-throws boundary, wrapped in its own catch: a hostile
   *  event (a getter or Proxy that throws during validation) becomes ok:false
   *  'invalid-event' carrying the thrown value's message — the outer catch would otherwise
   *  mislabel it 'internal'. A plain invalid event keeps the validator's own message. */
  private validateEvent(event: unknown): { ok: true; event: GameEvent } | { ok: false; message: string } {
    try {
      return validateGameEvent(event);
    } catch (err) {
      return { ok: false, message: safeStringify(err) };
    }
  }

  // ── Flows (DC-P6, faithful to today's leaves) ──

  /** `menu.open`: stampLastPlayed FIRST (the nav:action leaf's order), then the menu branch.
   *  No beats on this flow — the resume/menu views are the whole reply. */
  private dispatchMenuOpen(e: { type: 'menu.open'; playerId: string }): GameResponse {
    this.backend.stampLastPlayed(e.playerId);
    const result = this.backend.openActionMenu(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_MENU_COPY);
      case 'no-rolls':
        return this.error('no-rolls', NO_ROLLS_COPY);
      case 'resume-stale':
        // The stale-session narration rides `facts` (DC-P1) — present only when the
        // controller returned one; the slash /action stale paint's withNarration reads it.
        return this.error('stale-session', result.prompt, result.narration !== undefined ? { narration: result.narration } : undefined);
      case 'resume-decision':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view, facts: this.addCharacterFacts(e.playerId) });
      case 'resume-error':
        return this.error('internal', result.message);
      case 'menu':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view, facts: this.addCharacterFacts(e.playerId) });
      case 'menu-fallback':
        // DC-M9.2.3: composeActionMenu threw — the byte-identical fallback copy crosses
        // as an ok:true NoticeViewState rather than an internal-error string.
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: { screen: 'notice', text: result.text, ephemeral: true },
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `dayjob.start`: beginDayJob (its own inline stamp) → loading beat after the guards
   *  pass → commuteForWork → commute beat when commuted → runWork (DC-P5/P6). */
  private async dispatchDayJobStart(
    e: { type: 'dayjob.start'; playerId: string; jobIndex: number },
    onBeat: ((beat: GameResponse) => void) | undefined,
    idleOnce: () => string,
  ): Promise<GameResponse> {
    const begin = this.backend.beginDayJob(e.playerId, e.jobIndex);
    switch (begin.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'invalid-job':
        return this.error('illegal-move', INVALID_JOB_COPY);
      case 'unsafe':
        return this.error('unsafe', UNSAFE_COPY(begin.location));
      case 'ok':
        break;
    }

    this.emitBeat(onBeat, { v: PROTOCOL_VERSION, ok: true, view: { screen: 'loading', body: `⏳ **Starting…**\n_${idleOnce()}_` } });

    const commute = this.backend.commuteForWork(e.playerId, begin.workplace);
    if (commute.kind === 'commuted') {
      this.emitBeat(onBeat, { v: PROTOCOL_VERSION, ok: true, view: { screen: 'commute', destination: commute.destination, idle: idleOnce() } });
    }

    const worked = await this.backend.runWork(e.playerId, begin.workPrompt, begin.wage);
    return this.finalize(this.renderStartResult(worked, e.playerId));
  }

  /** `action.custom`: beginCustomAction → (resume → view, no beat) → thinking beat →
   *  runCustomAction. The 280-char clip is screen copy, so it lives here (DC-P5). */
  private async dispatchActionCustom(
    e: { type: 'action.custom'; playerId: string; text: string },
    onBeat: ((beat: GameResponse) => void) | undefined,
    idleOnce: () => string,
  ): Promise<GameResponse> {
    // DC-M9.3.9: profanity runs ahead of the character guard, matching the modal leaf's
    // pre-defer order today — a charless player submitting profane text gets rejected on
    // the profanity, not on the missing character.
    const blocked = checkProfanity(e.text);
    if (blocked !== null) return this.error('illegal-move', PROFANITY_COPY);

    const begin = this.backend.beginCustomAction(e.playerId);
    if (begin.kind === 'no-character') return this.error('no-character', NO_CHARACTER_COPY);
    if (begin.kind === 'resume') {
      // An in-flight action resumes straight to its decision view — no thinking beat.
      return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: begin.view, facts: this.addCharacterFacts(e.playerId) });
    }
    if (begin.kind === 'resume-stale') {
      // M9.2 review fix: mirrors dispatchMenuOpen's own resume-stale mapping exactly — the
      // narration rides `facts` only when the controller returned one.
      return this.error('stale-session', begin.prompt, begin.narration !== undefined ? { narration: begin.narration } : undefined);
    }
    // DC-M9.2 fix: the guard the pre-port top-of-handler check performed (rollsRemaining
    // <= 0, no pending action) never crossed the seam — moved behind beginCustomAction.
    // Precedes the loading beat, exactly like the other guard arms above.
    if (begin.kind === 'no-rolls') return this.error('no-rolls', NO_ROLLS_COPY);

    const clipped = e.text.length > 280 ? `${e.text.slice(0, 279).trimEnd()}…` : e.text;
    this.emitBeat(onBeat, { v: PROTOCOL_VERSION, ok: true, view: { screen: 'loading', body: `**You:** ${clipped}\n\n⏳ **Thinking…**\n_${idleOnce()}_` } });

    const started = await this.backend.runCustomAction(e.playerId, e.text);
    return this.finalize(this.renderStartResult(started, e.playerId));
  }

  /** `action.choose`: beginChoice → resolveChoice → thinking beat with the resolved label
   *  (only after resolution) → stepChoice (DC-P5/P6). A null resolution means the session
   *  expired — the engine no longer holds the decision the click referred to. */
  private async dispatchActionChoose(
    e: { type: 'action.choose'; playerId: string; selector: PendingChoiceSelector },
    onBeat: ((beat: GameResponse) => void) | undefined,
    idleOnce: () => string,
  ): Promise<GameResponse> {
    const begin = this.backend.beginChoice(e.playerId);
    if (begin.kind === 'no-character') return this.error('no-character', NO_CHARACTER_COPY);

    const label = this.backend.resolveChoice(begin.character, e.selector);
    // Falsy, mirroring the adapter's session-expired check byte-exactly (dispatchInteraction.ts:689).
    if (!label) return this.error('session-expired', SESSION_EXPIRED_COPY);

    this.emitBeat(onBeat, { v: PROTOCOL_VERSION, ok: true, view: { screen: 'loading', body: `**You:** ${label}\n\n⏳ **Thinking…**\n_${idleOnce()}_` } });

    const stepped = await this.backend.stepChoice(e.playerId, label, begin.character);
    switch (stepped.kind) {
      case 'decision':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: stepped.view, facts: this.addCharacterFacts(e.playerId) });
      case 'outcome':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: stepped.view, facts: this.addCharacterFacts(e.playerId, this.outcomeFacts(stepped)) });
    }
  }

  /** feedback.submit/bug.submit: reply-first best-effort (today's resilience) — the
   *  confirmation envelope is returned regardless of the persist's fate; a throwing
   *  recordFeedback is console.error-logged AND rides the envelope as the `persistFailed`
   *  fact (DC-M9.3.10), so the four dispatcher leaves that used to notifyAdmin on this
   *  throw directly can still do so from the fact rather than losing the signal to this
   *  method's own swallow. bug.submit defaults to the controller's 'outcome-bug' surface
   *  when absent (DC-P2). The two slash surfaces are the one exception to reply-first
   *  (DC-M9.5, M9.1): `/feedback` and `/bug` guard on a character today, so this guard
   *  preserves that — the other four surfaces are untouched, no extra `getCharacter` read
   *  on their path. */
  private dispatchFeedback(
    surface: FeedbackSurface,
    playerId: string,
    text: string,
    actionId: number | undefined,
  ): GameResponse {
    if ((surface === 'slash-feedback' || surface === 'slash-bug') && this.backend.getCharacter(playerId) === null) {
      return this.error('no-character', NO_CHARACTER_COPY);
    }
    const view = this.backend.feedbackConfirmation(surface);
    let persistFailed = false;
    try {
      this.backend.recordFeedback(surface, playerId, text, actionId);
    } catch (err) {
      console.error(`[protocol] recordFeedback failed: ${safeStringify(err)}`);
      persistFailed = true;
    }
    return this.finalize({
      v: PROTOCOL_VERSION,
      ok: true,
      view,
      ...(persistFailed ? { facts: { persistFailed: true } } : {}),
    });
  }

  /** `rest.begin` — the player's `/sleep` goodnight (M7.1, DC-M7.1.3). No beats (single-reply
   *  flow): the two guards map to `illegal-move` with the exact ⛔ copies from the old sleep.ts
   *  handler, the no-character arm uses the non-menu copy (the dispatcher's character gate
   *  reroutes gated commands before the handler — recorded copy unification), and the rested
   *  path returns the rest screen as a NoticeViewState with the character facts, adding the
   *  `restUnsafe` fact only when the rest was unsafe (DC-M7.1.4). */
  private dispatchRestBegin(e: { type: 'rest.begin'; playerId: string }): GameResponse {
    const result = this.backend.beginRest(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'mid-action':
        return this.error('illegal-move', MID_ACTION_COPY);
      case 'rolls-remaining':
        return this.error('illegal-move', ROLLS_REMAINING_COPY);
      case 'rested': {
        let facts = this.addCharacterFacts(e.playerId) ?? {}; // the rested arm always has a char, but the type can't know
        if (result.wasUnsafe) {
          const name = typeof facts.characterName === 'string' ? facts.characterName : 'Unknown';
          facts = {
            ...facts,
            restUnsafe: {
              name,
              prev: result.prev,
              updated: { health: result.updated.health, stamina: result.updated.stamina },
            },
          };
        }
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: { screen: 'notice', text: composeRestCopy(result), ephemeral: false },
          facts,
        });
      }
    }
  }

  /** `hi.open` — the `/hi` greeting screen (M7.2, DC-M7.2.3). No beats (single-reply flow,
   *  like `rest.begin`). NO_CHARACTER_COPY unifies the two no-character copies: the old
   *  handler's "…yet. Type `/join` to create one." copy is dead behind the slash gate (hi is
   *  in CHARACTER_GATED_COMMANDS), and the genuinely-reachable charless `nav:hi` edge (public
   *  announcement buttons — the generic nav branch calls the registry handler ungated)
   *  changes from "yet" to "first" — cosmetic, unpinned by any test (M1's nav:hi transcript
   *  and M7.0 transcripts 9–11 all have characters), the same unification M7.1 applied to
   *  the parallel charless `nav:sleep` edge; recorded for the reviewer. Both view arms
   *  return the NoticeViewState with the character facts (no new facts key). */
  private dispatchHiOpen(e: { type: 'hi.open'; playerId: string }): GameResponse {
    const result = this.backend.openHi(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'resume':
      case 'greeting':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `wizard.choose` — steps 2-7 option buttons (M7.3, DC-M7.3.6). The router's range/state
   *  checks (step is the current step, value is in the step's options) come back as
   *  `illegal-move` with WIZARD_ILLEGAL_CHOICE_COPY; a gone/expired session is `session-expired`
   *  with WIZARD_NO_SESSION_COPY. View arms carry NO facts (the walk's user has no character). */
  private dispatchWizardChoose(e: { type: 'wizard.choose'; playerId: string; step: number; value: string }): GameResponse {
    const result = this.backend.chooseWizardOption(e.playerId, e.step, e.value);
    switch (result.kind) {
      case 'no-session':
        return this.error('session-expired', WIZARD_NO_SESSION_COPY);
      case 'illegal-choice':
        return this.error('illegal-move', WIZARD_ILLEGAL_CHOICE_COPY);
      case 'view':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view });
    }
  }

  /** `join.open` — the slash `/join` start-or-resume (M7.3, DC-M7.3.6). `has-character`
   *  is an `illegal-move` with HAS_CHARACTER_COPY (byte-pinned by M7.0 transcript 2, painted
   *  via editReply without ❌); the view arm is the composed step screen, no facts. */
  private dispatchJoinOpen(e: { type: 'join.open'; playerId: string }): GameResponse {
    const result = this.backend.openJoin(e.playerId);
    switch (result.kind) {
      case 'has-character':
        return this.error('illegal-move', HAS_CHARACTER_COPY);
      case 'view':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view });
    }
  }

  /** `wizard.answer` — the step-1 free-text name (M7.3, DC-M7.3.6). `invalid-name` carries
   *  the store's own message (transcript 4 pins the handler's `❌ ${message}` paint); an
   *  answer aimed at a non-step-1 session is `illegal-move` with WIZARD_ILLEGAL_CHOICE_COPY. */
  private dispatchWizardAnswer(e: { type: 'wizard.answer'; playerId: string; text: string }): GameResponse {
    const result = this.backend.answerWizardName(e.playerId, e.text);
    switch (result.kind) {
      case 'no-session':
        return this.error('session-expired', WIZARD_NO_SESSION_COPY);
      case 'invalid-name':
        return this.error('illegal-move', result.message);
      case 'illegal-step':
        return this.error('illegal-move', WIZARD_ILLEGAL_CHOICE_COPY);
      case 'view':
        return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view });
    }
  }

  /** `wizard.restart` — reset + start always yields a fresh step-1 view (no error arms). */
  private dispatchWizardRestart(e: { type: 'wizard.restart'; playerId: string }): GameResponse {
    const result = this.backend.restartWizard(e.playerId);
    return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: result.view });
  }

  /** `character.create` — the step-8 confirm (M7.3, DC-M7.3.6/7). The created arm returns
   *  the new hero's /hi greeting as the view with `facts = { createdCharacter, ...addCharacterFacts }`
   *  (the announcement embed is welded adapter-side from the fact; the character facts follow
   *  the backend's getCharacter result — the mock's canned char on the bookend-oracle path). */
  private dispatchCharacterCreate(e: { type: 'character.create'; playerId: string }): GameResponse {
    const result = this.backend.confirmWizard(e.playerId);
    switch (result.kind) {
      case 'no-session':
        return this.error('session-expired', WIZARD_NO_SESSION_COPY);
      case 'not-ready':
        return this.error('illegal-move', WIZARD_NOT_READY_COPY);
      case 'created':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId, { createdCharacter: result.created }),
        });
    }
  }

  // ── M8.1 screens (DC-M8.4) — the six `screen.*` branches. Single-reply flows, no beats,
  // no stamps (the dispatcher's slash-arm post-handler stamp + nav branch pre-handler stamp
  // cover both arms; double-stamping is the bug being avoided). The five char-gated branches
  // share the no-character arm with NO_CHARACTER_COPY — the recorded "yet"→"first"
  // unification: behind the slash gate the old "yet" copy is dead, and the genuinely-reachable
  // charless `nav:*` edges change bytes (pinned by screens-oracle transcripts 4/8/10/13/16,
  // the M8.1 gate — nothing else churns). `screen.help` has NO no-character arm (DC-M8.3). ──

  /** `screen.look` — the scene survey. */
  private dispatchScreenLook(e: { type: 'screen.look'; playerId: string }): GameResponse {
    const result = this.backend.openLook(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'view':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `screen.map` — the discovered-graph render; the optional `focus` drills into a region
   *  or zooms to a place (adapter-extracted from the slash option until M9). */
  private dispatchScreenMap(e: { type: 'screen.map'; playerId: string; focus?: string }): GameResponse {
    const result = this.backend.openMap(e.playerId, e.focus);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'view':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `screen.stats` — the character sheet. */
  private dispatchScreenStats(e: { type: 'screen.stats'; playerId: string }): GameResponse {
    const result = this.backend.openStats(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'view':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `screen.backpack` — the inventory grid + stat groups. */
  private dispatchScreenBackpack(e: { type: 'screen.backpack'; playerId: string }): GameResponse {
    const result = this.backend.openBackpack(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'view':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `screen.journal` — the chronicle + NPC list. */
  private dispatchScreenJournal(e: { type: 'screen.journal'; playerId: string }): GameResponse {
    const result = this.backend.openJournal(e.playerId);
    switch (result.kind) {
      case 'no-character':
        return this.error('no-character', NO_CHARACTER_COPY);
      case 'view':
        return this.finalize({
          v: PROTOCOL_VERSION,
          ok: true,
          view: result.view,
          facts: this.addCharacterFacts(e.playerId),
        });
    }
  }

  /** `screen.help` — the command list + Economy block. No no-character arm (DC-M8.3): help
   *  works charless today, so the event always resolves to the view (facts follow the
   *  backend's getCharacter — absent on the charless path). */
  private dispatchScreenHelp(e: { type: 'screen.help'; playerId: string }): GameResponse {
    const result = this.backend.openHelp(e.playerId);
    return this.finalize({
      v: PROTOCOL_VERSION,
      ok: true,
      view: result.view,
      facts: this.addCharacterFacts(e.playerId),
    });
  }

  // ── Shared mapping (DC-P4) ──

  /** runWork/runCustomAction fan-out: the shared `StartRenderResult` → envelope map. The
   *  RA-6 identical viewPrivate/viewPublic pair travels as ONE view across the seam.
   *  `addCharacterFacts` adds the full character snapshot (DC-M6.1) on view-bearing
   *  branches; the outcome already has `outcomeFacts`, which `addCharacterFacts` merges
   *  with (same char data, second read within the same context). */
  private renderStartResult(result: StartRenderResult, userId: string): GameResponse {
    switch (result.kind) {
      case 'outcome':
        return { v: PROTOCOL_VERSION, ok: true, view: result.viewPrivate, facts: this.addCharacterFacts(userId, this.outcomeFacts(result)) };
      case 'empty-action':
        // Execution-state settle (1): the controller's raw firstDecision.prompt can be ''
        // and the validator rejects empty error.message — mirror the controller's own
        // resume-stale fallback. Copy-only on a dead edge.
        return this.error('empty-action', result.prompt || 'Could not recover.');
      case 'divine':
        // DC-M9.3: same dead-edge shape as empty-action above — the engine's divine
        // outcomeText is never empty; the fallback exists only because the validator
        // rejects an empty error.message. Copy-only on a dead edge.
        return this.error('divine-intervention', result.text || 'Your roll has been refunded.');
      case 'decision':
        return { v: PROTOCOL_VERSION, ok: true, view: result.view, facts: this.addCharacterFacts(userId) };
    }
  }

  /** Outcome facts (DC-P1 whitelist): dayjob.start/action.custom outcomes carry
   *  { distilledType, characterName, actionId?, nav, collapse }; action.choose adds
   *  characterClass (only its result carries it). `nav` is the exact three fields
   *  getNavButtons reads; `collapse` (DC-M9.2) is the pre/post vitals `announceCollapse`
   *  needs, from the result's `prevChar`/post-action `char` — both omitted when the char
   *  is gone (a null `next` makes `collapseNotice` a no-op, so omitting is lossless). */
  private outcomeFacts(result: {
    distilledType: string;
    characterName: string;
    actionId?: number;
    characterClass?: string | null;
    char: CharacterData | null;
    prevChar: CharacterData;
  }): Record<string, unknown> {
    const facts: Record<string, unknown> = {
      distilledType: result.distilledType,
      characterName: result.characterName,
    };
    if (result.actionId !== undefined) facts.actionId = result.actionId;
    if (result.characterClass != null) facts.characterClass = result.characterClass;
    if (result.char) {
      facts.nav = {
        rollsRemaining: result.char.rollsRemaining,
        hasPendingAction: result.char.lastActionState !== null,
        hasRestedToday: result.char.hasRestedToday ?? false,
      };
      facts.collapse = {
        name: result.char.name,
        prev: { health: result.prevChar.health, stamina: result.prevChar.stamina },
        updated: { health: result.char.health, stamina: result.char.stamina },
      };
    }
    return facts;
  }

  /** Character snapshot facts (DC-M6.1): populates `characterName`, `characterClass`
   *  (when non-null), `nav`, and `characterState` on view-bearing responses by reading
   *  the character through the backend. Called on every view-bearing branch (menu,
   *  resume, decision, outcome); the outcome path already has `outcomeFacts` setting the
   *  same name/class/nav keys — the merge overwrites with identical values from a second
   *  `getCharacter` read (same transaction, same data). Returns `undefined` when it
   *  produced nothing (no character AND no existing facts) — the M8.1 `screen.help`
   *  charless case, whose envelope then carries no facts key (the same no-facts
   *  convention as the wizard events). */
  private addCharacterFacts(userId: string, existingFacts?: Record<string, unknown>): Record<string, unknown> | undefined {
    const char = this.backend.getCharacter(userId);
    const facts: Record<string, unknown> = { ...existingFacts };
    if (char) {
      facts.characterName = char.name;
      if (char.class) facts.characterClass = char.class;
      facts.nav = {
        rollsRemaining: char.rollsRemaining,
        hasPendingAction: char.lastActionState !== null,
        hasRestedToday: char.hasRestedToday ?? false,
      };
      facts.characterState = {
        health: char.health,
        maxHealth: char.maxHealth,
        stamina: char.stamina,
        maxStamina: char.maxStamina,
        wealth: char.wealth,
        location: char.location,
      };
    }
    return Object.keys(facts).length === 0 ? undefined : facts;
  }

  // ── Envelope construction + the self-validation barrier ──

  private error(code: GameErrorCode, message: string, facts?: Record<string, unknown>): GameResponse {
    return this.finalize({
      v: PROTOCOL_VERSION,
      ok: false,
      error: { code, message },
      ...(facts !== undefined ? { facts } : {}),
    });
  }

  /** DC-M9.3.10 held that the log is where the original error's detail goes to survive
   *  once it can't cross the seam — this path was missing that log, so a controller throw
   *  vanished outright bar whatever notifyAdmin does with the envelope's message. */
  private internalError(err: unknown): GameResponse {
    console.error(`[protocol] internal error: ${safeStringify(err)}`);
    return this.error('internal', safeStringify(err));
  }

  /** Structural barrier: every final envelope crosses the seam only after its own validator
   *  accepts it; one that fails becomes ok:false 'internal' carrying the validation message. */
  private finalize(response: GameResponse): GameResponse {
    const check = validateGameResponse(response);
    if (check.ok) return check.response;
    return { v: PROTOCOL_VERSION, ok: false, error: { code: 'internal', message: check.message } };
  }

  /** Beats are advisory (settled onBeat semantics): a beat that fails its own validation is
   *  dropped with a console.error, and a throwing onBeat is try/caught so the flow continues
   *  and the final envelope always returns. */
  private emitBeat(onBeat: ((beat: GameResponse) => void) | undefined, beat: GameResponse): void {
    if (!onBeat) return;
    const check = validateGameResponse(beat);
    if (!check.ok) {
      console.error(`[protocol] dropped beat (beats are advisory): ${check.message}`);
      return;
    }
    try {
      onBeat(check.response);
    } catch (err) {
      console.error(`[protocol] onBeat threw: ${safeStringify(err)}`);
    }
  }
}
