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

import type { WorldEngine, CharacterData, PendingChoiceSelector } from '../engine/WorldEngine.js';
import type { NoticeViewState, DecisionViewState, OutcomeViewState, MenuViewState } from '../view/viewState.js';
import { buildDecisionView, buildOutcomeView } from '../view/actionViewState.js';
import { composeActionMenu, getDayJobActions, getWorkplaceLocation, type DayJobDef } from './dayJob.js';

export type FeedbackSurface = 'sleep' | 'release' | 'outcome-feedback' | 'outcome-bug';

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
  | { kind: 'menu'; view: MenuViewState };

/** Outcome of `beginDayJob` — mirrors the pre-M3.4 `action:dayjob:<n>` button handler's
 *  guard order exactly (char guard -> `updateLastPlayed` -> invalid-job -> unsafe-ground ->
 *  ok). `unsafe` carries the raw `location` so the adapter can render the inline warning. */
export type DayJobStart =
  | { kind: 'no-character' }
  | { kind: 'invalid-job' }
  | { kind: 'unsafe'; location: string }
  | { kind: 'ok'; workplace: string | null; workPrompt: string; wage: number };

/** Outcome of `runWork` — mirrors the pre-M3.4 handler's post-commute `startAction` +
 *  outcome-render logic exactly (same re-read-after-start, compact/full outcome fan-out,
 *  no `classEmoji` on the public content line — unlike `action:choice`). Carries no `error`
 *  arm: like `stepChoice`, errors propagate so the adapter's single outer try/catch covers
 *  start + paint + broadcast + announceCollapse, exactly like the pre-M3.4 handler's one
 *  outer try. */
export type DayJobRunResult =
  | { kind: 'outcome'; viewPrivate: OutcomeViewState; viewPublic: OutcomeViewState; distilledType: string; actionId?: number; characterName: string; char: CharacterData; prevChar: CharacterData }
  | { kind: 'empty-action'; prompt: string }
  | { kind: 'decision'; view: DecisionViewState };

export class SessionController {
  constructor(
    private readonly engine: WorldEngine,
    private readonly getCurrentScene: (userId: string) => string,
    private readonly dayJobs: DayJobDef[],
  ) {}

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

    return { kind: 'menu', view: composeActionMenu(this.engine, this.dayJobs, character) };
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
   *  same compact-private/full-public outcome fan-out, same NOT-compact decision view). Does
   *  NOT catch: `startAction`/view-build errors propagate so the adapter's single outer try
   *  can cover start + paint + broadcast + announceCollapse, exactly like the pre-M3.4
   *  handler's one outer try/catch. */
  async runWork(userId: string, workPrompt: string, wage: number): Promise<DayJobRunResult> {
    const prevChar = this.engine.getCharacter(userId);
    if (!prevChar) throw new Error(`runWork: no character for ${userId}`);

    // Per-action `income` (day-jobs.yml) rides the action as a guaranteed wage: paid into
    // the RESOLVED outcome (after the failure-strip) so it shows in the footer (💰) when
    // work finishes, not before. base_income is the separate nightly-tick wage.
    const result = await this.engine.startAction(prevChar.id, workPrompt, { kind: 'work', wage });

    if (result.outcome) {
      // Re-read AFTER startAction so the embed + nav reflect the spent roll and mutations —
      // `prevChar` is the pre-action (post-commute) snapshot, the before-baseline for
      // announceCollapse.
      const char = this.engine.getCharacter(userId) ?? prevChar;
      const scene = this.getCurrentScene(userId);
      return {
        kind: 'outcome',
        // Compact for private reply, full for public thread copy (F#19c).
        viewPrivate: buildOutcomeView(result.outcome, char, scene, result.state, { compact: true }, this.engine),
        viewPublic: buildOutcomeView(result.outcome, char, scene, result.state, undefined, this.engine),
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
    return { kind: 'decision', view: buildDecisionView(result.firstDecision, 0, result.state, prevChar, result.actionType) };
  }

  /** The confirmation copy for a feedback/bug submission — a pure function of the surface, so it
   *  can be shown BEFORE the best-effort persist (preserving reply-first resilience). */
  feedbackConfirmation(surface: FeedbackSurface): NoticeViewState {
    const text =
      surface === 'outcome-bug' ? '🐛 Bug noted. The warden will investigate.'
      : surface === 'release'   ? '🙏 Noted. The warden carries your words forward.'
      : '🙏 Thanks. The warden listens.';
    return { screen: 'notice', text, ephemeral: true };
  }

  /** Best-effort persist. No character → no-op (matches the current `if (char)` guard). Passes an
   *  actionId only for the outcome surfaces, matching each leaf's current arg count exactly. */
  recordFeedback(surface: FeedbackSurface, userId: string, text: string, actionId?: number): void {
    const char = this.engine.getCharacter(userId);
    if (!char) return;
    switch (surface) {
      case 'outcome-bug': this.engine.submitBug(char.id, text, actionId); break;
      case 'outcome-feedback': this.engine.submitFeedback(char.id, text, actionId); break;
      default: this.engine.submitFeedback(char.id, text); break; // sleep, release — no actionId
    }
  }
}
