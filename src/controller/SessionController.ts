/**
 * Transport-neutral session controller (JSON-seam M3, see
 * docs/engine/json-seam-build-plans.md). This is the first real controller slice — it holds
 * the engine and produces `ViewState` for the surfaces it owns. Imports ONLY
 * `type { WorldEngine }` and view-state types — **never `discord.js`** — that non-import is
 * the controller's structural guarantee: it stays reusable by any future medium (Discord
 * today, an agent adapter later) without dragging transport concerns in. Stateless in M3.1:
 * session state is engine-owned (parent decision 1), so this class is a thin pass-through
 * that later slices extend as the seam grows.
 */

import type { WorldEngine, CharacterData, PendingChoiceSelector, ActionStartResult, CharCreateData } from '../engine/WorldEngine.js';
import type { NoticeViewState, DecisionViewState, OutcomeViewState, MenuViewState, WizardViewState } from '../view/viewState.js';
import { buildDecisionView, buildOutcomeView } from '../view/actionViewState.js';
import { composeActionMenu, getDayJobActions, getWorkplaceLocation, type DayJobDef } from './dayJob.js';
import { dayJobEmoji } from '../discord/format.js';
import { composeHiScreen } from './hiScreen.js';
import { composeWizardView, isValidWizardChoice, type CharDefs } from './joinWizard.js';
import { composeLookScreen, type SceneLookupFn } from './lookScreen.js';
import { composeMapScreen } from './mapScreen.js';
import { composeStatsScreen } from './statsScreen.js';
import { composeBackpackScreen } from './backpackScreen.js';
import { composeJournalScreen } from './journalScreen.js';
import { composeHelpScreen } from './helpScreen.js';
import type { WizardSession, WizardState } from '../discord/WizardSession.js';

// M9.1 (DC-M9.5): 'slash-feedback'/'slash-bug' are the /feedback and /bug slash commands'
// surfaces — same persist routing and confirmation copy as their outcome siblings, guarded
// on a character in the router (dispatchFeedback) rather than here.
export type FeedbackSurface = 'sleep' | 'release' | 'outcome-feedback' | 'outcome-bug' | 'slash-feedback' | 'slash-bug';

/** Outcome of the `getCharacter` guard the pre-M3.2 button handler ran BEFORE deferring —
 *  split out from choice resolution (M3.2c) so the adapter can defer unconditionally right
 *  after this guard, matching the old ordering: guard → defer → parse customId. */
export type BeginChoiceResult =
  | { kind: 'no-character' }
  | { kind: 'ok'; character: CharacterData };

/** Outcome of stepping the action machine with a resolved label (M3.2 DC-C) — mirrors the
 *  pre-M3.2 button handler's step + outcome-render logic exactly: `decision` and `outcome`
 *  carry everything the adapter needs to paint without touching the engine again. Carries
 *  no `error` arm (M3.2c) — `stepAction`/view-build errors propagate to the caller so a
 *  single inner try/catch can cover step + paint + broadcast + announceCollapse, exactly
 *  like the pre-M3.2 handler's one inner try. */
export type StepChoiceResult =
  | { kind: 'decision'; view: DecisionViewState }
  | { kind: 'outcome'; view: OutcomeViewState; distilledType: string; actionId?: number; characterName: string; characterClass?: string | null; char: CharacterData | null; prevChar: CharacterData };

/** Outcome of `openActionMenu` — mirrors the pre-M3.3b `nav:action` leaf's branch order
 *  exactly (char guard -> rolls guard -> resume-in-progress -> fresh menu). The "⏳ Stale
 *  Action" embed stays an inline adapter embed (M3.3 design call DC-I) — `resume-stale`
 *  carries the raw prompt/narration so the adapter can paint it, not a view-state. */
export type ActionMenuResult =
  | { kind: 'no-character' }
  | { kind: 'no-rolls' }
  | { kind: 'resume-stale'; prompt: string; narration?: string }
  | { kind: 'resume-decision'; view: DecisionViewState }
  | { kind: 'resume-error'; message: string }
  | { kind: 'menu'; view: MenuViewState }
  // DC-M9.2.3: composeActionMenu is called untried, so a throw (e.g. an engine.getMeta
  // failure) needs a seam-visible fallback — the byte-identical day-job-name copy
  // commands/action.ts:133 painted inline before the port.
  | { kind: 'menu-fallback'; text: string };

/** Outcome of `beginRest` (M7.1, DC-M7.1.2) — mirrors the pre-M7.1 `/sleep` handler's guard
 *  order exactly: no-character → mid-action (`lastActionState !== null`) → rolls-remaining
 *  (`rollsRemaining > 0`) → rest. `alreadyThere`/`prev`/`unsafeFromName` come from the pre-rest
 *  char; `updated`/`wasUnsafe` from the engine result (the unsafe-rest −1 HP rule lives inside
 *  `restAtOak` now — this side only computes the workplace exemption the engine needs). */
export type RestBeginResult =
  | { kind: 'no-character' }
  | { kind: 'mid-action' }
  | { kind: 'rolls-remaining' }
  | { kind: 'rested'; alreadyThere: boolean; prev: { health: number; stamina: number }; updated: CharacterData; wasUnsafe: boolean; unsafeFromName: string };

/** Outcome of `openHi` (M7.2, DC-M7.2.2) — the `/hi` greeting screen crosses the seam as
 *  `hi.open`. Char guard, then `composeHiScreen` (the composition lifted byte-for-byte from
 *  the pre-seam hi.ts handler into the controller layer). NO stamp: the dispatcher's generic
 *  post-handler `stampLastPlayed` covers `/hi`, and the nav branch stamps before its handler
 *  — a stamp here would double-stamp. */
export type HiOpenResult =
  | { kind: 'no-character' }
  | { kind: 'resume'; view: NoticeViewState }
  | { kind: 'greeting'; view: NoticeViewState };

// ── M7.3 wizard results (DC-M7.3.5) — the five `character.create`-flow results. Guard
// order mirrors the old join handlers exactly; the step→field map (2 class … 7 itemSet)
// lives below. The view arms carry `WizardViewState` (DC-M7.3.3); the `created` arm carries
// the hi greeting + the CharCreateData the router crosses as the `createdCharacter` fact. ──

export type JoinOpenResult = { kind: 'has-character' } | { kind: 'view'; view: WizardViewState };

export type WizardAnswerResult =
  | { kind: 'no-session' }
  | { kind: 'invalid-name'; message: string }
  | { kind: 'illegal-step' }
  | { kind: 'view'; view: WizardViewState };

export type WizardOptionResult =
  | { kind: 'no-session' }
  | { kind: 'illegal-choice' }
  | { kind: 'view'; view: WizardViewState };

export type WizardRestartResult = { kind: 'view'; view: WizardViewState }; // restart always starts fresh (reset + start)

export type WizardConfirmResult =
  | { kind: 'no-session' }
  | { kind: 'not-ready' }
  | { kind: 'created'; view: NoticeViewState; created: CharCreateData };

// ── M8.1 screen results (DC-M8.3) — the six `screen.*` flows. The five char-gated screens
// return `ScreenOpenResult` (char guard, then the composed NoticeViewState); `openHelp` has
// NO char guard (help works charless today — DC-M8.3's no-gate pin) and returns
// `HelpOpenResult`. NO stamps inside any `open*`: the dispatcher's slash-arm post-handler
// stamp and the nav branch's pre-handler stamp cover both arms — a stamp here would
// double-stamp (the hi.open precedent; DC-M8.7 pins it). The views carry `ephemeral: true`
// (informational — the dispatcher's ephemeralCommands list drives the actual paint until
// M9, the same note as the hi screen). ──

export type ScreenOpenResult =
  | { kind: 'no-character' }
  | { kind: 'view'; view: NoticeViewState };

export type HelpOpenResult = { kind: 'view'; view: NoticeViewState };

/** The wizard's step→state-field map (2 class … 7 itemSet) — the controller owns it. */
const WIZARD_FIELD_MAP: Record<
  number,
  'class' | 'upbringing' | 'race' | 'alignment' | 'dayJob' | 'itemSet'
> = {
  2: 'class',
  3: 'upbringing',
  4: 'race',
  5: 'alignment',
  6: 'dayJob',
  7: 'itemSet',
};

/** Outcome of `beginDayJob` — mirrors the pre-M3.4 `action:dayjob:<n>` button handler's
 *  guard order exactly (char guard -> `updateLastPlayed` -> invalid-job -> unsafe-ground ->
 *  ok). `unsafe` carries the raw `location` so the adapter can render the inline warning. */
export type DayJobStart =
  | { kind: 'no-character' }
  | { kind: 'invalid-job' }
  | { kind: 'unsafe'; location: string }
  | { kind: 'ok'; workplace: string | null; workPrompt: string; wage: number };

/** Outcome of `startAction`'s post-start render fan-out (`renderStartResult`) — shared by
 *  `runWork` (M3.4) and `runCustomAction` (M3.5) since both start-then-render an action
 *  identically (same re-read-after-start, same outcome view for both arms since RA-6, no `classEmoji` on
 *  the public content line — unlike `action:choice`). Carries no `error` arm: errors
 *  propagate so the adapter's single outer try/catch covers start + paint + broadcast +
 *  announceCollapse, exactly like the pre-M3.4/pre-M3.5 handlers' one outer try. */
export type StartRenderResult =
  | { kind: 'outcome'; viewPrivate: OutcomeViewState; viewPublic: OutcomeViewState; distilledType: string; actionId?: number; characterName: string; char: CharacterData; prevChar: CharacterData }
  | { kind: 'empty-action'; prompt: string }
  | { kind: 'decision'; view: DecisionViewState }
  // DC-M9.3: a refunded divine-intervention roll — a system fault, not a real outcome.
  | { kind: 'divine'; text: string };

/** Outcome of `beginCustomAction` — mirrors the pre-M3.5 `action:custom:modal` submit leaf's
 *  guard order exactly (char guard -> resume-in-progress -> rolls -> start). Still no try
 *  around `resumeAction` (unlike `openActionMenu`'s combined stale-try) — a resume throw
 *  here propagates to the adapter's outer try, matching the leaf.
 *  DC-M9.2 fix: the pre-port `commands/action.ts:67` top guard (`rollsRemaining <= 0 &&
 *  !lastActionState`) never crossed the seam — the resume arm above already claims every
 *  pending-action case, so `no-rolls` needs no `lastActionState` conjunct of its own.
 *  M9.2 review fix: the resume arm now shares `openActionMenu`'s empty-options guard (see
 *  `resume-stale` below) — `/action <text>` on a stale pending action used to render a
 *  decision view with a synthetic Continue button instead of the dedicated stale notice. */
export type BeginCustomActionResult =
  | { kind: 'no-character' }
  | { kind: 'resume'; view: DecisionViewState }
  // M9.2 review fix: mirrors `openActionMenu`'s own empty-options guard (below) — a resume
  // with zero options is the dedicated grey ⏳ Stale Action notice, not a decision render
  // with a synthetic Continue button.
  | { kind: 'resume-stale'; prompt: string; narration?: string }
  | { kind: 'no-rolls' }
  | { kind: 'start' };

export class SessionController {
  constructor(
    private readonly engine: WorldEngine,
    private readonly getCurrentScene: (userId: string) => string,
    private readonly dayJobs: DayJobDef[],
    private readonly characterGatedCommands: ReadonlySet<string> = new Set(),
    // M7.3 (DC-M7.3.1/5): the join wizard's multi-step draft is controller-held session state
    // (see docs/decisions/wizard-session-ownership.md) — the store is constructor-injected
    // (index.ts creates ONE instance shared with the dispatcher's joinWizards dep), and the
    // defs the wizard renders from are required at every construction site.
    private readonly wizards: WizardSession,
    private readonly wizardDefs: CharDefs,
    // M8.1 (DC-M8.5): look's `resolveScene` is a controller constructor dep (the wizardDefs
    // precedent) — the type moved with the composer into src/controller/lookScreen.ts. The
    // dispatch-harness constructs this with its FIXED stub (a deliberate determinism choice
    // for the screens oracle); index.ts/play.ts pass the real tag→scene resolver.
    private readonly resolveScene: SceneLookupFn,
  ) {}

  /** Reroute-to-join gate for a slash command (M3.6 DC-O) — true when the command needs a
   *  character the user lacks. Membership is checked first so `characterExists` only runs for
   *  gated commands, preserving the pre-M3.6 adapter short-circuit. The adapter owns the
   *  registry swap to the join handler; the controller owns only this decision. */
  needsCharacterGate(userId: string, commandName: string): boolean {
    return this.characterGatedCommands.has(commandName) && !this.engine.characterExists(userId);
  }

  /** Thin pass-through to the engine — the M6.1 `characterState` router fact needs the
   *  character snapshot on every view-bearing response (DC-M6.1). */
  getCharacter(userId: string): CharacterData | null {
    return this.engine.getCharacter(userId);
  }

  /** Stamp last-interaction time (M3.6 DC-N) — the `getCharacter` + `updateLastPlayed` pattern
   *  the pre-M3.6 slash-arm and nav-click leaves both ran inline. No character → no-op.
   *  (`beginDayJob` keeps its own inline stamp: it already holds the char from its guard.) */
  stampLastPlayed(userId: string): void {
    const char = this.engine.getCharacter(userId);
    if (char) this.engine.updateLastPlayed(char.id);
  }

  /** The `getCharacter` guard alone (M3.2c) — the pre-M3.2 handler ran this BEFORE
   *  `deferUpdate`, and only this; the customId parse and choice resolution both
   *  happened AFTER the defer, so they're split into `resolveChoice` below. */
  beginChoice(userId: string): BeginChoiceResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return { kind: 'ok', character };
  }

  /** Resolves the clicked option/bail button against the engine's own pending-decision
   *  state (M3.2 DC-A) — a thin pass-through to `engine.resolvePendingChoice`, called
   *  AFTER `deferUpdate` (mirrors the pre-M3.2 handler's ordering). */
  resolveChoice(character: CharacterData, selector: PendingChoiceSelector): string | null {
    return this.engine.resolvePendingChoice(character.id, selector);
  }

  /** Steps the action machine with the resolved label — mirrors the pre-M3.2 button
   *  handler's step + apply-result logic exactly (same re-read-after-step, same
   *  NOT-compact outcome view, same scene source). Does NOT catch: `stepAction`/view-build
   *  errors propagate so the adapter's single inner try can cover step + paint + broadcast
   *  + announceCollapse, exactly like the pre-M3.2 handler's one inner try/catch. */
  async stepChoice(userId: string, label: string, prevChar: CharacterData): Promise<StepChoiceResult> {
    const result = await this.engine.stepAction(prevChar.id, label);
    if (result.resolved) {
      const char = this.engine.getCharacter(userId);
      const view = buildOutcomeView(result.outcome, char, this.getCurrentScene(userId), result.state, undefined, this.engine);
      return {
        kind: 'outcome',
        view,
        distilledType: result.outcome.distilledType,
        actionId: result.outcome.actionId,
        characterName: char?.name ?? 'Unknown',
        characterClass: char?.class,
        char,
        prevChar,
      };
    }
    const char = this.engine.getCharacter(userId);
    const view = buildDecisionView(result.nextDecision, result.state.decisions.length, result.state, char ?? undefined);
    return { kind: 'decision', view };
  }

  /** Reproduces the pre-M3.3b `nav:action` leaf's guard/resume/menu order exactly (DC-I) —
   *  char guard -> rolls guard -> resume-in-progress (stale/decision/error) -> fresh menu.
   *  Shared by the slash `/action` no-description path too via `composeActionMenu`. */
  openActionMenu(userId: string): ActionMenuResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };

    if (character.rollsRemaining <= 0 && !character.lastActionState) {
      return { kind: 'no-rolls' };
    }

    if (character.lastActionState) {
      try {
        const resumeResult = this.engine.resumeAction(character.id);
        if (resumeResult.nextDecision.options.length === 0) {
          return {
            kind: 'resume-stale',
            prompt: resumeResult.nextDecision.prompt || 'Could not recover.',
            narration: resumeResult.nextDecision.narration,
          };
        }
        const view = buildDecisionView(resumeResult.nextDecision, resumeResult.state.decisions.length, resumeResult.state, character);
        return { kind: 'resume-decision', view };
      } catch (err) {
        return { kind: 'resume-error', message: err instanceof Error ? err.message : String(err) };
      }
    }

    // DC-M9.2.3: composeActionMenu is called untried today (a throw propagates to the
    // caller's own catch) — wrapped here so the fallback copy travels with the flow it
    // belongs to instead of surfacing a raw internal-error string.
    try {
      return { kind: 'menu', view: composeActionMenu(this.engine, this.dayJobs, character) };
    } catch {
      return {
        kind: 'menu-fallback',
        text: `${dayJobEmoji(character.dayJob)} **${character.dayJob}**\n\nUse \`/action <what you do>\` to start an action.`,
      };
    }
  }

  /** Reproduces the pre-M7.1 `/sleep` handler's guard order exactly (DC-M7.1.2): no-character
   *  → mid-action → rolls-remaining → rest. The H1 workplace exemption is computed here (the
   *  controller owns dayJobs) and passed to `engine.restAtOak` as `opts.workplace`; the unsafe
   *  condition + −1 penalty live in the engine (DC-M7.1.1). `updated` is never null on the
   *  rested arm — the char guard precedes the engine call. */
  beginRest(userId: string): RestBeginResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };

    if (character.lastActionState !== null) return { kind: 'mid-action' };

    if (character.rollsRemaining > 0) return { kind: 'rolls-remaining' };

    const alreadyThere = character.location === "The Warden's Oak";
    const dayNumber = Number(this.engine.getMeta('day_number') ?? '1');
    // H1: treat sleeping at your own workplace as safe (no HP penalty for doing your job).
    const workplace = getWorkplaceLocation(character.dayJob, this.dayJobs, {
      characterId: character.id,
      dayNumber,
    });
    const result = this.engine.restAtOak(userId, { workplace });
    // The char guard above guarantees the engine saw a character — non-null on this path.
    return {
      kind: 'rested',
      alreadyThere,
      prev: { health: character.health, stamina: character.stamina },
      updated: result.character!,
      wasUnsafe: result.wasUnsafe,
      unsafeFromName: result.unsafeFromName,
    };
  }

  /** The `/hi` greeting screen (M7.2, DC-M7.2.2) — char guard, then the composeHiScreen
   *  fan-out (greeting pieces built, then the lastActionState short-circuit to the resume
   *  screen, exactly the old handler's branch order). No stamp (see HiOpenResult). */
  openHi(userId: string): HiOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return composeHiScreen(this.engine, this.dayJobs, character);
  }

  // ── M8.1 screens (DC-M8.3/5/6) — one controller method per screen; each is the char guard
  // (except openHelp) then the byte-for-byte composition lifted into the controller layer.
  // No stamps, no beats (single-reply flows). ──

  /** `screen.look` — the scene survey. The null-location branch lives inside the composer
   *  (byte-for-byte: the "lost to the warden's sight" copy precedes resolveScene). */
  openLook(userId: string): ScreenOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return {
      kind: 'view',
      view: { screen: 'notice', text: composeLookScreen(this.engine, this.resolveScene, character), ephemeral: true },
    };
  }

  /** `screen.map` — the discovered-graph render. `focus` is the slash-arm drill-down
   *  (adapter-extracted until M9); absent → the full map. */
  openMap(userId: string, focus?: string): ScreenOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return {
      kind: 'view',
      view: { screen: 'notice', text: composeMapScreen(this.engine, character, focus), ephemeral: true },
    };
  }

  /** `screen.stats` — the character sheet (formatStats + the gear breakdown). */
  openStats(userId: string): ScreenOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return {
      kind: 'view',
      view: { screen: 'notice', text: composeStatsScreen(this.engine, character), ephemeral: true },
    };
  }

  /** `screen.backpack` — the inventory emoji grid + stat groups. */
  openBackpack(userId: string): ScreenOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return {
      kind: 'view',
      view: { screen: 'notice', text: composeBackpackScreen(this.engine, character), ephemeral: true },
    };
  }

  /** `screen.journal` — the chronicle + NPC list. */
  openJournal(userId: string): ScreenOpenResult {
    const character = this.engine.getCharacter(userId);
    if (!character) return { kind: 'no-character' };
    return {
      kind: 'view',
      view: { screen: 'notice', text: composeJournalScreen(this.engine, character), ephemeral: true },
    };
  }

  /** `screen.help` — the command list + Economy block. NO char guard (DC-M8.3): help works
   *  charless today and gating it would be a behaviour change, so the event has no
   *  no-character arm and this method always returns the view. `_userId` is the seam's
   *  uniform playerId — help performs no engine read, so it is deliberately unused (the
   *  MockWorldEngine `getExits(_location)` convention). */
  openHelp(_userId: string): HelpOpenResult {
    return { kind: 'view', view: { screen: 'notice', text: composeHelpScreen(), ephemeral: true } };
  }

  /** `join.open` (DC-M7.3.5) — mirrors the old slash handler's guard order exactly:
   *  `characterExists` → start-or-resume (the old try/catch resume logic: a start throw
   *  means an active session, which resumes — or restarts when expired) → composed view. */
  openJoin(userId: string): JoinOpenResult {
    if (this.engine.characterExists(userId)) return { kind: 'has-character' };

    let state: WizardState;
    try {
      state = this.wizards.start(userId);
    } catch {
      // Already in a wizard — resume (or restart if expired).
      const existing = this.wizards.getSession(userId);
      if (!existing || this.wizards.isExpired(userId)) {
        this.wizards.reset(userId);
        state = this.wizards.start(userId);
      } else {
        state = existing;
      }
    }
    return { kind: 'view', view: composeWizardView(state, this.wizardDefs) };
  }

  /** `wizard.answer` (DC-M7.3.5) — the step-1 free-text name. No-session/expired (reset on
   *  expiry) → step-1 check (`illegal-step`) → `setName` in try/catch (`invalid-name` with
   *  the store's message). */
  answerWizardName(userId: string, name: string): WizardAnswerResult {
    const state = this.wizardStateOrNull(userId);
    if (!state) return { kind: 'no-session' };
    if (state.step !== 1) return { kind: 'illegal-step' };
    try {
      const updated = this.wizards.setName(userId, name);
      return { kind: 'view', view: composeWizardView(updated, this.wizardDefs) };
    } catch (e) {
      return { kind: 'invalid-name', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** `wizard.choose` (DC-M7.3.5) — steps 2-7 option buttons. No-session/expired → `step`
   *  matches AND `isValidWizardChoice` (`illegal-choice`) → `choose` (the pre-checks make
   *  its throw unreachable). */
  chooseWizardOption(userId: string, step: number, value: string): WizardOptionResult {
    const state = this.wizardStateOrNull(userId);
    if (!state) return { kind: 'no-session' };
    if (state.step !== step || !isValidWizardChoice(step, value, this.wizardDefs, state.class)) {
      return { kind: 'illegal-choice' };
    }
    const updated = this.wizards.choose(userId, step, WIZARD_FIELD_MAP[step], value);
    return { kind: 'view', view: composeWizardView(updated, this.wizardDefs) };
  }

  /** `wizard.restart` (DC-M7.3.5) — reset + start always yields a fresh step-1 view. */
  restartWizard(userId: string): WizardRestartResult {
    this.wizards.reset(userId);
    const state = this.wizards.start(userId);
    return { kind: 'view', view: composeWizardView(state, this.wizardDefs) };
  }

  /** `character.create` (DC-M7.3.5) — the step-8 confirm. No-session/expired → step 8
   *  (`not-ready`) → `wizards.confirm` → `engine.createCharacter` → the new hero's /hi
   *  greeting (the same composition the dispatcher's post-confirm renderHiScreen paints).
   *  The char guard precedent: `updated`-style reads assume the engine persisted the row
   *  (the M7.0 transcript 6 canned char is the mock's documented non-persist stand-in). */
  confirmWizard(userId: string): WizardConfirmResult {
    const state = this.wizardStateOrNull(userId);
    if (!state) return { kind: 'no-session' };
    if (state.step !== 8) return { kind: 'not-ready' };
    const data = this.wizards.confirm(userId);
    this.engine.createCharacter(userId, data);
    const char = this.engine.getCharacter(userId);
    if (!char) throw new Error(`confirmWizard: createCharacter did not persist a character for ${userId}`);
    const hi = composeHiScreen(this.engine, this.dayJobs, char);
    return { kind: 'created', view: hi.view, created: data };
  }

  /** The wizard store's no-session/expired gate — an expired session is cleared (the old
   *  getOrThrow's delete-on-expiry semantics) and reported as no-session so the router
   *  paints the WIZARD_NO_SESSION_COPY. */
  private wizardStateOrNull(userId: string): WizardState | null {
    const state = this.wizards.getSession(userId);
    if (!state) return null;
    if (this.wizards.isExpired(userId)) {
      this.wizards.reset(userId);
      return null;
    }
    return state;
  }

  /** Reproduces the pre-M3.4 `action:dayjob:<n>` button handler's guard order exactly
   *  (DC-K): char guard -> `updateLastPlayed` stamp -> resolve the clicked job action ->
   *  invalid-job -> resolve the workplace -> unsafe-ground guard (workplace itself is
   *  always exempt) -> ok, carrying everything `commuteForWork`/`runWork` need next. */
  beginDayJob(userId: string, idx: number): DayJobStart {
    const char = this.engine.getCharacter(userId);
    if (!char) return { kind: 'no-character' };

    this.engine.updateLastPlayed(char.id); // M2: stamp on day-job clicks

    const dayNumber = Number(this.engine.getMeta('day_number') ?? '1');
    const jobActions = getDayJobActions(char.dayJob, this.dayJobs, { characterId: char.id, dayNumber });
    const jobAction = jobActions[idx];
    if (!jobAction?.hook) return { kind: 'invalid-job' };

    // Block daily work from unsafe ground (unknown/procedural locations count as unsafe,
    // mirroring the unsafe-soul count). Freeform `/action` is unaffected. Exception: your
    // job's own workplace is unsafe-exempt.
    const workplace = getWorkplaceLocation(char.dayJob, this.dayJobs, { characterId: char.id, dayNumber });
    const atWorkplace = workplace !== null && char.location === workplace;
    const here = this.engine.getLocation(char.location);
    if (!here?.isSafe && !atWorkplace) return { kind: 'unsafe', location: char.location };

    // Lead the prompt with the task label so the LLM always gets the concrete, payable
    // task ("Walk the rounds") up front, with the hook as flavour — the hook alone reads
    // as atmosphere and can bury what the player is actually doing.
    return { kind: 'ok', workplace, workPrompt: `${jobAction.label} — ${jobAction.hook}`, wage: jobAction.income ?? 0 };
  }

  /** Thin pass-through to `engine.commuteToWorkplace` (DC-K) — the engine persists the
   *  stamina/location mutation and returns the destination, so a re-read after this call
   *  already reflects the commute (no local char patching needed on this side). */
  commuteForWork(userId: string, workplace: string | null): { kind: 'commuted'; destination: string } | { kind: 'none' } {
    const char = this.engine.getCharacter(userId);
    if (!char) return { kind: 'none' };
    const commute = this.engine.commuteToWorkplace(char.id, workplace);
    return commute ? { kind: 'commuted', destination: commute.to } : { kind: 'none' };
  }

  /** Steps the action machine with the day-job's assembled work prompt (DC-K) — mirrors the
   *  pre-M3.4 handler's `startAction` + apply-result logic exactly (same re-read-after-start,
   *  same outcome fan-out — full embed on both arms since RA-6 — same decision view). Does
   *  NOT catch: `startAction`/view-build errors propagate so the adapter's single outer try
   *  can cover start + paint + broadcast + announceCollapse, exactly like the pre-M3.4
   *  handler's one outer try/catch. */
  async runWork(userId: string, workPrompt: string, wage: number): Promise<StartRenderResult> {
    const prevChar = this.engine.getCharacter(userId);
    if (!prevChar) throw new Error(`runWork: no character for ${userId}`);

    // Per-action `income` (day-jobs.yml) rides the action as a guaranteed wage: paid into
    // the RESOLVED outcome (after the failure-strip) so it shows in the footer (💰) when
    // work finishes, not before. base_income is the separate nightly-tick wage.
    const result = await this.engine.startAction(prevChar.id, workPrompt, { kind: 'work', wage });
    return this.renderStartResult(userId, prevChar, result);
  }

  /** `beginCustomAction`'s char/resume/rolls guard (DC-M2, DC-M9.2 fix) — mirrors the
   *  pre-M3.5 `action:custom:modal` submit leaf's guard order exactly. No try around
   *  `resumeAction` (unlike `openActionMenu`'s stale-embed handling): a resume throw
   *  propagates to the adapter's outer try, matching the leaf. The rolls check runs AFTER
   *  the resume check (not before, unlike `openActionMenu`'s combined
   *  `rollsRemaining <= 0 && !lastActionState` guard) — a mid-action player with 0 rolls
   *  must still resume. */
  beginCustomAction(userId: string): BeginCustomActionResult {
    const char = this.engine.getCharacter(userId);
    if (!char) return { kind: 'no-character' };
    if (char.lastActionState !== null) {
      const r = this.engine.resumeAction(char.id);
      // M9.2 review fix: mirrors openActionMenu's empty-options guard — a resume with no
      // options renders a decision view with nothing to click, so this arm short-circuits
      // to the same stale-notice shape `openActionMenu` returns.
      if (r.nextDecision.options.length === 0) {
        return { kind: 'resume-stale', prompt: r.nextDecision.prompt || 'Could not recover.', narration: r.nextDecision.narration };
      }
      return { kind: 'resume', view: buildDecisionView(r.nextDecision, r.state.decisions.length, r.state, char) };
    }
    if (char.rollsRemaining <= 0) return { kind: 'no-rolls' };
    return { kind: 'start' };
  }

  /** Starts the free-text custom action and delegates to the shared fan-out (DC-M2/DC-M3) —
   *  no `opts` (default quest kind, no wage), unlike `runWork`. Does NOT catch: errors
   *  propagate so the adapter's single outer try covers start + paint + broadcast +
   *  announceCollapse, exactly like the pre-M3.5 handler's one outer try/catch. */
  async runCustomAction(userId: string, description: string): Promise<StartRenderResult> {
    const prevChar = this.engine.getCharacter(userId);
    if (!prevChar) throw new Error(`runCustomAction: no character for ${userId}`);
    const result = await this.engine.startAction(prevChar.id, description);
    return this.renderStartResult(userId, prevChar, result);
  }

  /** Shared start-then-render fan-out (DC-M3), lifted byte-for-byte from the pre-M3.5
   *  `runWork` body — `runWork` and `runCustomAction` both call `startAction` then hand the
   *  result here. `getCurrentScene` is called ONCE per outcome, matching the original single
   *  call site. */
  private renderStartResult(userId: string, prevChar: CharacterData, result: ActionStartResult): StartRenderResult {
    // Divine intervention is a system fault, not a real action outcome — return the distinct
    // `divine` arm and stop, BEFORE the outcome branch below (which would otherwise repaint a
    // refunded roll as a normal outcome and misreport it), mirroring action.ts:155-157's ordering.
    if (result.outcome?.isDivineIntervention) {
      return { kind: 'divine', text: result.outcome.outcomeText };
    }
    if (result.outcome) {
      // Re-read AFTER startAction so the embed + nav reflect the spent roll and mutations —
      // `prevChar` is the pre-action snapshot, the before-baseline for announceCollapse.
      const char = this.engine.getCharacter(userId) ?? prevChar;
      const scene = this.getCurrentScene(userId);
      // RA-6: both replies now carry the SAME full embed. The old F#19c compact-private variant
      // hid the story thread because "the player just saw it in the decision embed" — but these
      // are the auto-resolve paths, where no decision embed was ever shown, so the private reply
      // was strictly missing the gamebook trail. One build shared by both arms: the view is a
      // plain DTO and `outcomeViewToDiscord` only reads it, so aliasing is safe and avoids
      // rendering the identical frames twice.
      const view = buildOutcomeView(result.outcome, char, scene, result.state, undefined, this.engine);
      return {
        kind: 'outcome',
        viewPrivate: view,
        viewPublic: view,
        distilledType: result.outcome.distilledType,
        actionId: result.outcome.actionId,
        characterName: char.name,
        char,
        prevChar,
      };
    }
    if (result.firstDecision.options.length === 0) {
      return { kind: 'empty-action', prompt: result.firstDecision.prompt };
    }
    // DC-M9.2.2: actionType/combatEnemyName/combatEnemyCondition are consumed INSIDE
    // buildDecisionView to fill the opening frame and don't survive onto DecisionViewState —
    // dropping args 6/7 here silently rendered every combat opening frame with the
    // 'Unknown foe' placeholder and no banded condition since the paths crossed the seam.
    return { kind: 'decision', view: buildDecisionView(result.firstDecision, 0, result.state, prevChar, result.actionType, result.combatEnemyName, result.combatEnemyCondition) };
  }

  /** The confirmation copy for a feedback/bug submission — a pure function of the surface, so it
   *  can be shown BEFORE the best-effort persist (preserving reply-first resilience). */
  feedbackConfirmation(surface: FeedbackSurface): NoticeViewState {
    const text =
      surface === 'outcome-bug' || surface === 'slash-bug' ? '🐛 Bug noted. The warden will investigate.'
      : surface === 'release'   ? '🙏 Noted. The warden carries your words forward.'
      : '🙏 Thanks. The warden listens.';
    return { screen: 'notice', text, ephemeral: true };
  }

  /** Best-effort persist. No character → no-op (matches the current `if (char)` guard). Passes an
   *  actionId only for the outcome surfaces, matching each leaf's current arg count exactly.
   *  `slash-bug` mirrors `outcome-bug` minus the actionId — commands/bug.ts calls
   *  `submitBug(character.id, interaction.text)` with no actionId today. */
  recordFeedback(surface: FeedbackSurface, userId: string, text: string, actionId?: number): void {
    const char = this.engine.getCharacter(userId);
    if (!char) return;
    switch (surface) {
      case 'outcome-bug': this.engine.submitBug(char.id, text, actionId); break;
      case 'slash-bug': this.engine.submitBug(char.id, text); break;
      case 'outcome-feedback': this.engine.submitFeedback(char.id, text, actionId); break;
      default: this.engine.submitFeedback(char.id, text); break; // sleep, release, slash-feedback — no actionId
    }
  }
}
