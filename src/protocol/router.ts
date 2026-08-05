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
  RestBeginResult,
  SessionController,
  StartRenderResult,
  StepChoiceResult,
} from '../controller/SessionController.js';
import type { CharacterData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { NoticeViewState } from '../view/viewState.js';

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
          return await this.dispatchFeedback('outcome-bug', e.playerId, e.text, e.actionId);
        case 'rest.begin':
          return this.dispatchRestBegin(e);
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
    const begin = this.backend.beginCustomAction(e.playerId);
    if (begin.kind === 'no-character') return this.error('no-character', NO_CHARACTER_COPY);
    if (begin.kind === 'resume') {
      // An in-flight action resumes straight to its decision view — no thinking beat.
      return this.finalize({ v: PROTOCOL_VERSION, ok: true, view: begin.view, facts: this.addCharacterFacts(e.playerId) });
    }

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
   *  recordFeedback is console.error-logged, never surfaced. bug.submit maps to the
   *  controller's 'outcome-bug' surface (DC-P2). */
  private dispatchFeedback(
    surface: FeedbackSurface,
    playerId: string,
    text: string,
    actionId: number | undefined,
  ): GameResponse {
    const view = this.backend.feedbackConfirmation(surface);
    try {
      this.backend.recordFeedback(surface, playerId, text, actionId);
    } catch (err) {
      console.error(`[protocol] recordFeedback failed: ${safeStringify(err)}`);
    }
    return this.finalize({ v: PROTOCOL_VERSION, ok: true, view });
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
        let facts = this.addCharacterFacts(e.playerId);
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
      case 'decision':
        return { v: PROTOCOL_VERSION, ok: true, view: result.view, facts: this.addCharacterFacts(userId) };
    }
  }

  /** Outcome facts (DC-P1 whitelist): dayjob.start/action.custom outcomes carry
   *  { distilledType, characterName, actionId?, nav }; action.choose adds characterClass
   *  (only its result carries it). `nav` is the exact three fields getNavButtons reads,
   *  from the result's post-action char — omitted when the char is gone. */
  private outcomeFacts(result: {
    distilledType: string;
    characterName: string;
    actionId?: number;
    characterClass?: string | null;
    char: CharacterData | null;
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
    }
    return facts;
  }

  /** Character snapshot facts (DC-M6.1): populates `characterName`, `characterClass`
   *  (when non-null), `nav`, and `characterState` on view-bearing responses by reading
   *  the character through the backend. Called on every view-bearing branch (menu,
   *  resume, decision, outcome); the outcome path already has `outcomeFacts` setting the
   *  same name/class/nav keys — the merge overwrites with identical values from a second
   *  `getCharacter` read (same transaction, same data). When the character is null (the
   *  caller already passed the guard, so this shouldn't happen), the existing facts are
   *  returned unchanged. */
  private addCharacterFacts(userId: string, existingFacts?: Record<string, unknown>): Record<string, unknown> {
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
    return facts;
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

  private internalError(err: unknown): GameResponse {
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
